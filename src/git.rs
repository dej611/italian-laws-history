use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, NaiveDate, Utc};
use tokio::process::Command;

use crate::types::{BranchableShort, Config};

/// The data branch this Rust port writes to (sibling of the TS port's `history`).
pub const HISTORY_BRANCH: &str = "history-rs";

/// The "home" branch the script lives on. Mirrors the TS code's safety
/// `git checkout main` calls — for the Rust port this is `rust`.
pub const MAIN_BRANCH: &str = "rust";

/// Suffix appended to every provisional-act branch namespace (`dl`, `rdl`,
/// `dll`, `dlcps`) so the Rust port's branches don't collide with the TS
/// port's. Effective namespaces become `dl-rs/`, `rdl-rs/`, `dll-rs/`,
/// `dlcps-rs/`.
pub const BRANCH_SUFFIX: &str = "-rs";

/// Build a namespaced branch name for a provisional act: `<short>-rs/<codice>`.
pub fn branch_name_for(short: BranchableShort, codice: &str) -> String {
    format!("{}{BRANCH_SUFFIX}/{codice}", short.as_str())
}

/// Back-compat helper: produces `dl-rs/<codice>`.
#[deprecated(note = "use `branch_name_for(BranchableShort::Dl, codice)`")]
#[allow(dead_code)]
pub fn dl_branch_name(codice: &str) -> String {
    branch_name_for(BranchableShort::Dl, codice)
}

/// Seed `.gitignore` for the `history-rs` data branch.
///
/// `history-rs` only tracks law-content files (`*.txt`, `*.decaduto`,
/// `*.modifiedby`). Everything else — Rust sources, build artefacts,
/// CI workflows, the binary's own runtime artefacts — is ignored so
/// that a developer who has the Rust source checked out in the working
/// tree (e.g. via a worktree, or simply switching branches) doesn't
/// accidentally pollute the data branch.
const HISTORY_GITIGNORE: &str = "\
# This branch (history-rs) is data-only. It only tracks law-content
# files; everything else is ignored so that a working tree shared with
# the `rust` source branch doesn't pollute commits here.

# --- Rust source tree (lives on the `rust` branch) ---
src/
target/
Cargo.toml
Cargo.lock
.github/
rust-toolchain
rust-toolchain.toml

# --- TS source tree (lives on `main`) ---
package.json
package-lock.json
tsconfig.json
node_modules/
*.ts
*.js
*.mjs
*.cjs

# --- Editor / OS noise ---
.DS_Store
*.swp
.cursor/
.idea/
.vscode/
talk/

# --- Runtime artefacts of either binary ---
progress.json
progress.json.tmp
progress-rs.json
progress-rs.json.tmp
processing-*.log
trace-*.json
*.cpuprofile

# Belt-and-braces: anything that's clearly not a law-content file.
# `*.txt`, `*.decaduto`, `*.modifiedby`, and the existing tracked
# `.gitignore` itself are all explicitly NOT ignored — git only
# applies these patterns to untracked paths anyway.
*.rs
*.yml
*.yaml
*.toml
*.lock
";


pub struct GitHelpers {
    config: Arc<Config>,
}

impl GitHelpers {
    pub fn new(config: Arc<Config>) -> Self {
        Self { config }
    }

    fn cwd(&self) -> &str {
        &self.config.output_repo
    }

    fn base_env(&self, commit_date: Option<&str>) -> Vec<(&'static str, String)> {
        let mut env = vec![
            ("GIT_AUTHOR_NAME", self.config.author_name.clone()),
            ("GIT_AUTHOR_EMAIL", self.config.author_email.clone()),
            ("GIT_COMMITTER_NAME", self.config.author_name.clone()),
            ("GIT_COMMITTER_EMAIL", self.config.author_email.clone()),
        ];
        if let Some(d) = commit_date {
            env.push(("GIT_AUTHOR_DATE", d.to_string()));
            env.push(("GIT_COMMITTER_DATE", d.to_string()));
        }
        env
    }

    async fn run(&self, args: &[&str], commit_date: Option<&str>) -> Result<()> {
        let mut cmd = Command::new("git");
        cmd.current_dir(self.cwd())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in self.base_env(commit_date) {
            cmd.env(k, v);
        }
        let out = cmd.output().await.with_context(|| format!("spawning git {args:?}"))?;
        if !out.status.success() {
            return Err(anyhow!(
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    /// Run `git` and report exit status without erroring on non-zero exits.
    /// Used for predicate-style checks like `git diff --cached --quiet`.
    async fn run_status(&self, args: &[&str]) -> Result<bool> {
        let mut cmd = Command::new("git");
        cmd.current_dir(self.cwd())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = cmd.status().await.with_context(|| format!("spawning git {args:?}"))?;
        Ok(status.success())
    }

    async fn run_capture(&self, args: &[&str]) -> Result<String> {
        let out = Command::new("git")
            .current_dir(self.cwd())
            .args(args)
            .output()
            .await
            .with_context(|| format!("spawning git {args:?}"))?;
        if !out.status.success() {
            return Err(anyhow!(
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    pub async fn ensure_repo(&self) -> Result<()> {
        tokio::fs::create_dir_all(self.cwd())
            .await
            .with_context(|| format!("creating output repo at {}", self.cwd()))
    }

    pub async fn ensure_history_branch(&self) -> Result<()> {
        let branches = self.run_capture(&["branch", "--list"]).await?;
        let exists = branches
            .lines()
            .map(|l| l.trim_start_matches('*').trim())
            .any(|name| name == HISTORY_BRANCH);
        if !exists {
            self.run(&["checkout", "--orphan", HISTORY_BRANCH], None).await?;
            // Best-effort wipe: ignore non-zero (empty index is fine).
            let _ = self.run_status(&["rm", "-rf", "."]).await;

            // Seed a .gitignore so the data branch ignores the Rust source
            // tree (and friends) that may exist in the working directory.
            // history-rs is data-only: only the law-content files are tracked.
            let gitignore_path = std::path::Path::new(self.cwd()).join(".gitignore");
            tokio::fs::write(&gitignore_path, HISTORY_GITIGNORE)
                .await
                .with_context(|| format!("writing {}", gitignore_path.display()))?;

            self.run(&["add", ".gitignore"], None).await?;
            self.run(
                &["commit", "-m", "initial history-rs branch with .gitignore"],
                None,
            )
            .await?;
        }
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub async fn checkout(&self) -> Result<()> {
        self.run(&["checkout", HISTORY_BRANCH], None).await
    }

    pub async fn pull(&self) -> Result<()> {
        // Best-effort: ignore failures (no remote, branch unpublished, etc.).
        let _ = self.run_status(&["pull", "origin", HISTORY_BRANCH]).await;
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub async fn push(&self) -> Result<()> {
        let _ = self.run_status(&["push", "origin", HISTORY_BRANCH]).await;
        Ok(())
    }

    pub async fn dl_branch_exists(&self, branch: &str) -> Result<bool> {
        let branches = self.run_capture(&["branch", "--list", branch]).await?;
        Ok(!branches.trim().is_empty())
    }

    pub async fn create_dl_branch(&self, branch: &str) -> Result<()> {
        self.run(&["checkout", HISTORY_BRANCH], None).await?;
        self.run(&["checkout", "-b", branch], None).await
    }

    pub async fn checkout_branch(&self, branch: &str) -> Result<()> {
        self.run(&["checkout", branch], None).await
    }

    pub async fn delete_dl_branch(&self, branch: &str) -> Result<()> {
        self.run(&["branch", "-D", branch], None).await
    }

    /// Abort an in-progress merge if one exists. No-op when no merge is in
    /// progress (git exits non-zero in that case, which we ignore). Used by
    /// error handlers to clear a conflicted index before falling back to the
    /// history branch.
    pub async fn abort_merge_if_any(&self) -> Result<()> {
        // run_status returns false on non-zero exit — that's the "no merge in
        // progress" case. Either way, control returns to the caller cleanly.
        let _ = self.run_status(&["merge", "--abort"]).await?;
        Ok(())
    }

    /// Stage file paths, then commit only if the index has staged changes.
    /// `iso_date` is "YYYY-MM-DD"; pre-1970 dates are clamped to the epoch.
    #[tracing::instrument(skip(self, files))]
    pub async fn commit_local_multi(
        &self,
        files: &[&str],
        message: &str,
        iso_date: &str,
    ) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let git_date = to_git_date(iso_date);
        let mut add_args: Vec<&str> = Vec::with_capacity(files.len() + 1);
        add_args.push("add");
        add_args.extend_from_slice(files);
        self.run(&add_args, Some(&git_date)).await?;

        // Skip when nothing is staged. `diff --cached --quiet` exits 0 (nothing) or 1 (changes).
        let nothing_staged = self.run_status(&["diff", "--cached", "--quiet"]).await?;
        if nothing_staged {
            return Ok(());
        }

        self.run(&["commit", "-m", message], Some(&git_date)).await
    }

    /// Stage a single file and commit. Mirrors the TS `commitLocal` helper
    /// used for the `.decaduto` marker in the DL-lapse path.
    pub async fn commit_local(&self, file: &str, message: &str, iso_date: &str) -> Result<()> {
        self.commit_local_multi(&[file], message, iso_date).await
    }

    /// Merge a `<short>/<codice>` branch into `history-rs` with the supplied
    /// historically-accurate date.
    ///
    /// Conflict policy: prefer the natural merge. If it conflicts, abort and
    /// retry with `-X ours` so `history-rs`'s final state wins. Rationale: when
    /// a `dl/<codice>` branch (pre-decadenza text) collides with `history-rs`
    /// (which already carries Normattiva's post-decadenza `Modifica:` commits —
    /// e.g. "DECRETO DECADUTO; I SUOI EFFETTI SONO STATI FATTI SALVI DALLA L.
    /// ..."), the post-decadenza state is the authoritative final form. The
    /// pre-decadenza text remains reachable via `git log <branch>`. The merge
    /// commit itself still records the DL's lifecycle on the timeline.
    #[tracing::instrument(skip(self))]
    pub async fn merge_dl_branch(
        &self,
        branch: &str,
        message: &str,
        iso_date: &str,
    ) -> Result<()> {
        let git_date = to_git_date(iso_date);
        self.run(&["checkout", HISTORY_BRANCH], Some(&git_date)).await?;
        match self
            .run(&["merge", "--no-ff", branch, "-m", message], Some(&git_date))
            .await
        {
            Ok(()) => Ok(()),
            Err(_) => {
                // Natural merge failed (almost always content conflicts on the
                // law text file because Normattiva already updated it on
                // history-rs with a post-decadenza marker). Abort, then retry
                // with `-X ours` so history-rs's final state wins.
                self.abort_merge_if_any().await?;
                self.run(
                    &["merge", "--no-ff", "-X", "ours", branch, "-m", message],
                    Some(&git_date),
                )
                .await
            }
        }
    }

    /// Octopus merge: combine multiple branches into `history-rs` in one commit
    /// with N+1 parents. Used for bulk ratifications such as
    /// L. 17 aprile 1925 n. 473 and L. 17 aprile 1956 n. 561, where one act
    /// ratifies an entire cohort of provisional decrees in a single stroke.
    ///
    /// Falls back to the regular two-parent merge when only one branch is
    /// supplied (octopus needs ≥ 2 sources). No-op when the slice is empty.
    #[tracing::instrument(skip(self, branches, message), fields(count = branches.len()))]
    pub async fn octopus_merge(
        &self,
        branches: &[String],
        message: &str,
        iso_date: &str,
    ) -> Result<()> {
        if branches.is_empty() {
            return Ok(());
        }
        if branches.len() == 1 {
            return self.merge_dl_branch(&branches[0], message, iso_date).await;
        }
        let git_date = to_git_date(iso_date);
        self.run(&["checkout", HISTORY_BRANCH], Some(&git_date)).await?;
        let mut args: Vec<&str> = vec!["merge", "--no-ff", "-m", message];
        for b in branches {
            args.push(b.as_str());
        }
        match self.run(&args, Some(&git_date)).await {
            Ok(()) => Ok(()),
            Err(_) => {
                // Octopus can't take `-X ours`, so on conflict abort and fall
                // back to sequential two-parent merges. Each call goes through
                // `merge_dl_branch`, which itself retries with `-X ours` when
                // needed.
                self.abort_merge_if_any().await?;
                for b in branches {
                    self.merge_dl_branch(b, message, iso_date).await?;
                }
                Ok(())
            }
        }
    }

    /// Best-effort sync `git checkout rust`. Mirrors the TS `checkoutMainSync`.
    pub fn checkout_main_sync(&self) {
        checkout_main_sync_for_repo(self.cwd());
    }
}

/// Best-effort sync `git checkout rust` for [`process::exit`] paths (no `Drop`).
pub fn checkout_main_sync_for_repo(cwd: &str) {
    let _ = std::process::Command::new("git")
        .current_dir(cwd)
        .args(["checkout", MAIN_BRANCH])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Convert an ISO date string to git's `@<unix-ts> +0000` form. Pre-epoch
/// dates clamp to 0; the *real* historical date is preserved in the commit
/// message body.
pub fn to_git_date(iso_date: &str) -> String {
    let ts = parse_iso_to_timestamp(iso_date).unwrap_or(0).max(0);
    format!("@{ts} +0000")
}

fn parse_iso_to_timestamp(iso: &str) -> Option<i64> {
    if let Ok(d) = DateTime::parse_from_rfc3339(iso) {
        return Some(d.timestamp());
    }
    let date = NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()?;
    let dt = date.and_hms_opt(0, 0, 0)?.and_utc();
    Some(dt.timestamp())
}

#[allow(dead_code)]
pub fn now_iso_date() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

#[allow(dead_code)]
fn _path_assert(_p: &Path) {} // keeps `Path` import quiet during scaffolding

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_epoch_clamps_to_zero() {
        assert_eq!(to_git_date("1861-01-01"), "@0 +0000");
    }

    #[test]
    fn modern_iso_round_trips() {
        let s = to_git_date("2020-06-15");
        assert!(s.starts_with('@') && s.ends_with(" +0000"));
        let ts: i64 = s[1..s.len() - 6].parse().unwrap();
        assert!(ts > 1_500_000_000);
    }
}
