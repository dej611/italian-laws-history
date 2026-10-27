use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, NaiveDate, Utc};
use tokio::process::Command;

use crate::types::{BranchableShort, Config};

/// The data branch the scraper writes law content to.
pub const HISTORY_BRANCH: &str = "history";

/// The source-code branch. Exit / Ctrl-C restores this checkout.
pub const MAIN_BRANCH: &str = "main";

/// Subject index at the tip of `history`. One commit per line, oldest first.
/// A `GU` or `Modifica:` line that names a single act file appends a tab and
/// that `.txt`. OpenNorme reads this file instead of walking ancestry.
pub const COMMIT_INDEX: &str = "commit-index.tsv";

/// One index row. Tabs and newlines in the subject become spaces.
fn commit_index_line(message: &str, files: &[&str]) -> String {
    let subject = message.replace(['\t', '\n', '\r'], " ");
    match naming_slug(&subject, files) {
        Some(slug) => format!("{subject}\t{slug}\n"),
        None => format!("{subject}\n"),
    }
}

/// The act `.txt` a naming commit introduces, when there is exactly one
/// (allegato sidecars do not count).
fn naming_slug<'a>(subject: &str, files: &[&'a str]) -> Option<&'a str> {
    if !subject.starts_with("GU ") && !subject.starts_with("Modifica:") {
        return None;
    }
    let mut found = None;
    for file in files {
        if file.ends_with(".txt") && !file.contains(".allegato-") {
            if found.is_some() {
                return None;
            }
            found = Some(*file);
        }
    }
    found
}

fn append_index(dir: &str, text: &str) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    let path = Path::new(dir).join(COMMIT_INDEX);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    file.write_all(text.as_bytes())?;
    Ok(())
}

/// `git log --name-only --pretty=format:%x1e%s` for a just-merged range.
/// File lists longer than a single act's sidecars are dropped: a shallow
/// root commit would otherwise list the whole tree.
fn index_lines_from_name_only_log(log: &str) -> String {
    let mut out = String::new();
    let mut subject: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    for line in log.split('\n') {
        if let Some(rest) = line.strip_prefix('\u{1e}') {
            push_index_row(&mut out, &mut subject, &mut files);
            subject = Some(rest.to_string());
        } else if line.is_empty() {
            continue;
        } else if subject.is_some() {
            files.push(line.to_string());
        }
    }
    push_index_row(&mut out, &mut subject, &mut files);
    out
}

fn push_index_row(out: &mut String, subject: &mut Option<String>, files: &mut Vec<String>) {
    let Some(message) = subject.take() else {
        return;
    };
    let owned: Vec<&str> = if files.len() > 30 {
        Vec::new()
    } else {
        files.iter().map(String::as_str).collect()
    };
    out.push_str(&commit_index_line(&message, &owned));
    files.clear();
}

/// When no merged commit named a single file, attach the one new act file
/// from the merge diff to the last naming subject.
fn attach_net_slug(lines: &str, slug: &str) -> String {
    let mut rows: Vec<String> = lines.lines().map(str::to_string).collect();
    let target = rows.iter().rposition(|row| {
        let subject = row.split('\t').next().unwrap_or("");
        subject.starts_with("GU ") || subject.starts_with("Modifica:")
    });
    if let Some(i) = target {
        if !rows[i].contains('\t') {
            rows[i].push('\t');
            rows[i].push_str(slug);
        }
    }
    if rows.is_empty() {
        String::new()
    } else {
        let mut out = rows.join("\n");
        out.push('\n');
        out
    }
}

/// Build a namespaced branch name for a provisional act: `<short>/<codice>`.
pub fn branch_name_for(short: BranchableShort, codice: &str) -> String {
    format!("{}/{}", short.as_str(), codice)
}

/// Back-compat helper: produces `dl/<codice>`.
#[deprecated(note = "use `branch_name_for(BranchableShort::Dl, codice)`")]
#[allow(dead_code)]
pub fn dl_branch_name(codice: &str) -> String {
    branch_name_for(BranchableShort::Dl, codice)
}

/// Seed `.gitignore` for the `history` data branch.
///
/// `history` only tracks law-content files (`*.txt`, `*.decaduto`,
/// `*.modifiedby`, `*.refs`). Everything else — Rust sources, build artefacts,
/// CI workflows, the binary's own runtime artefacts — is ignored so
/// that a developer who has the source checked out in the working
/// tree (e.g. via a worktree, or simply switching branches) doesn't
/// accidentally pollute the data branch.
const HISTORY_GITIGNORE: &str = "\
# This branch (history) is data-only. It only tracks law-content
# files; everything else is ignored so that a working tree shared with
# the `main` source branch doesn't pollute commits here.

# --- Rust source tree (lives on the `main` branch) ---
src/
tests/
target/
Cargo.toml
Cargo.lock
.github/
rust-toolchain
rust-toolchain.toml

# --- leftover TS files ---
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
allegati.json
processing-*.log
trace-*.json
*.cpuprofile

# Belt-and-braces: anything that's clearly not a law-content file.
# Law content: `*.txt` (incl. `*.allegato-N.txt`), `*.decaduto`,
# `*.modifiedby`, `*.refs` (allegato elenco sidecars). The tracked
# `.gitignore` itself is also kept.
*.rs
*.yml
*.yaml
*.toml
*.lock
*.html
";

pub struct GitHelpers {
    config: Arc<Config>,
}

/// Result of a bulk merge: branches successfully merged vs failures.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OctopusMergeResult {
    pub merged_branches: Vec<String>,
    pub failed_branches: Vec<(String, String)>,
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
        let mut cmd = tokio_git();
        cmd.current_dir(self.cwd())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in self.base_env(commit_date) {
            cmd.env(k, v);
        }
        let out = cmd
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
        Ok(())
    }

    /// Run `git` and report exit status without erroring on non-zero exits.
    /// Used for predicate-style checks like `git diff --cached --quiet`.
    async fn run_stdout(&self, args: &[&str]) -> Result<String> {
        let mut cmd = tokio_git();
        cmd.current_dir(self.cwd())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let out = cmd
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
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    async fn head_sha(&self) -> Result<String> {
        let out = self.run_stdout(&["rev-parse", "HEAD"]).await?;
        Ok(out.trim().to_string())
    }

    /// Append subjects of commits just merged into `history`, then amend that
    /// merge so the index stays inside the merge commit.
    async fn record_commits_since(&self, before: &str, git_date: &str) -> Result<()> {
        let range = format!("{before}..HEAD");
        let log = self
            .run_stdout(&[
                "log",
                "--reverse",
                "--name-only",
                "--pretty=format:%x1e%s",
                &range,
            ])
            .await?;
        let mut extra = index_lines_from_name_only_log(&log);
        if extra.is_empty() {
            return Ok(());
        }
        if !extra.lines().any(|line| line.contains('\t')) {
            let diff = self
                .run_stdout(&["diff", "--name-only", before, "HEAD"])
                .await?;
            let txts: Vec<&str> = diff
                .lines()
                .filter(|file| file.ends_with(".txt") && !file.contains(".allegato-"))
                .collect();
            if txts.len() == 1 {
                extra = attach_net_slug(&extra, txts[0]);
            }
        }
        append_index(self.cwd(), &extra)?;
        self.run(&["add", COMMIT_INDEX], Some(git_date)).await?;
        self.run(&["commit", "--amend", "--no-edit"], Some(git_date))
            .await
    }

    async fn run_status(&self, args: &[&str]) -> Result<bool> {
        let mut cmd = tokio_git();
        cmd.current_dir(self.cwd())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = cmd
            .status()
            .await
            .with_context(|| format!("spawning git {args:?}"))?;
        Ok(status.success())
    }

    pub async fn ensure_repo(&self) -> Result<()> {
        tokio::fs::create_dir_all(self.cwd())
            .await
            .with_context(|| format!("creating output repo at {}", self.cwd()))
    }

    pub async fn ensure_history_branch(&self) -> Result<()> {
        if ensure_local_tracking_branch(self.cwd(), HISTORY_BRANCH)? {
            return Ok(());
        }
        self.run(&["checkout", "--orphan", HISTORY_BRANCH], None)
            .await?;
        // Best-effort wipe: ignore non-zero (empty index is fine).
        let _ = self.run_status(&["rm", "-rf", "."]).await;

        // Seed a .gitignore so the data branch ignores the Rust source
        // tree (and friends) that may exist in the working directory.
        // history is data-only: only the law-content files are tracked.
        let gitignore_path = std::path::Path::new(self.cwd()).join(".gitignore");
        tokio::fs::write(&gitignore_path, HISTORY_GITIGNORE)
            .await
            .with_context(|| format!("writing {}", gitignore_path.display()))?;

        self.run(&["add", ".gitignore"], None).await?;
        self.run(
            &["commit", "-m", "initial history branch with .gitignore"],
            None,
        )
        .await?;
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
        push_origin(self.cwd(), &["origin", HISTORY_BRANCH])
    }

    /// Push a provisional-act branch so a GitHub PR can open.
    /// No `origin` is a no-op. A rejected push fails the scrape.
    pub async fn push_branch(&self, branch: &str) -> Result<()> {
        push_origin(self.cwd(), &["-u", "origin", branch])
    }

    /// Best-effort delete of a provisional-act branch on `origin`. Call only
    /// after `history` has been pushed, so GitHub can mark the PR merged.
    pub async fn delete_remote_branch(&self, branch: &str) -> Result<()> {
        let _ = self
            .run_status(&["push", "origin", "--delete", branch])
            .await;
        Ok(())
    }

    pub async fn dl_branch_exists(&self, branch: &str) -> Result<bool> {
        ensure_local_tracking_branch(self.cwd(), branch)
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

        // Only the history tip carries the index. Commits on a provisional
        // branch are recorded when that branch is merged.
        if current_branch_sync(self.cwd()).as_deref() == Some(HISTORY_BRANCH) {
            append_index(self.cwd(), &commit_index_line(message, files))?;
            self.run(&["add", COMMIT_INDEX], Some(&git_date)).await?;
        }

        self.run(&["commit", "-m", message], Some(&git_date)).await
    }

    /// Stage a single file and commit. Mirrors the TS `commitLocal` helper
    /// used for the `.decaduto` marker in the DL-lapse path.
    pub async fn commit_local(&self, file: &str, message: &str, iso_date: &str) -> Result<()> {
        self.commit_local_multi(&[file], message, iso_date).await
    }

    async fn try_merge_dl_branch(
        &self,
        branch: &str,
        message: &str,
        git_date: &str,
        strategy_ours: bool,
        allow_unrelated: bool,
    ) -> Result<()> {
        let mut args: Vec<&str> = vec!["merge", "--no-ff"];
        if allow_unrelated {
            args.push("--allow-unrelated-histories");
        }
        if strategy_ours {
            args.push("-X");
            args.push("ours");
        }
        args.push(branch);
        args.push("-m");
        args.push(message);
        self.run(&args, Some(git_date)).await
    }

    /// Merge a `<short>/<codice>` branch into `history` with the supplied
    /// historically-accurate date.
    ///
    /// Conflict policy: prefer the natural merge. If it conflicts, abort and
    /// retry with `-X ours` so `history`'s final state wins. Rationale: when
    /// a `dl/<codice>` branch (pre-decadenza text) collides with `history`
    /// (which already carries Normattiva's post-decadenza `Modifica:` commits —
    /// e.g. "DECRETO DECADUTO; I SUOI EFFETTI SONO STATI FATTI SALVI DALLA L.
    /// ..."), the post-decadenza state is the authoritative final form. The
    /// pre-decadenza text remains reachable via `git log <branch>`. The merge
    /// commit itself still records the DL's lifecycle on the timeline.
    ///
    /// When git reports unrelated histories (common for sanatoria bulk merges
    /// after a history branch rebuild), retries with `--allow-unrelated-histories`.
    #[tracing::instrument(skip(self))]
    pub async fn merge_dl_branch(&self, branch: &str, message: &str, iso_date: &str) -> Result<()> {
        let git_date = to_git_date(iso_date);
        self.run(&["checkout", HISTORY_BRANCH], Some(&git_date))
            .await?;
        let before = self.head_sha().await?;

        let attempts: &[(bool, bool)] =
            &[(false, false), (true, false), (true, true), (false, true)];
        let mut last_err: Option<anyhow::Error> = None;
        for (i, &(strategy_ours, allow_unrelated)) in attempts.iter().enumerate() {
            match self
                .try_merge_dl_branch(branch, message, &git_date, strategy_ours, allow_unrelated)
                .await
            {
                Ok(()) => {
                    self.record_commits_since(&before, &git_date).await?;
                    return Ok(());
                }
                Err(err) => {
                    last_err = Some(err);
                    if i + 1 == attempts.len() {
                        break;
                    }
                    self.abort_merge_if_any().await?;
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("merge of {branch} failed")))
    }

    /// Octopus merge: combine multiple branches into `history` in one commit
    /// with N+1 parents. Used for bulk ratifications such as
    /// L. 17 aprile 1925 n. 473 and L. 17 aprile 1956 n. 561, where one act
    /// ratifies an entire cohort of provisional decrees in a single stroke.
    ///
    /// Falls back to the regular two-parent merge when only one branch is
    /// supplied (octopus needs ≥ 2 sources). No-op when the slice is empty.
    /// Per-branch failures during the sequential fallback do not abort the
    /// whole sanatoria — callers inspect [`OctopusMergeResult`].
    #[tracing::instrument(skip(self, branches, message), fields(count = branches.len()))]
    pub async fn octopus_merge(
        &self,
        branches: &[String],
        message: &str,
        iso_date: &str,
    ) -> Result<OctopusMergeResult> {
        if branches.is_empty() {
            return Ok(OctopusMergeResult::default());
        }
        if branches.len() == 1 {
            let branch = &branches[0];
            return match self.merge_dl_branch(branch, message, iso_date).await {
                Ok(()) => Ok(OctopusMergeResult {
                    merged_branches: vec![branch.clone()],
                    failed_branches: Vec::new(),
                }),
                Err(err) => Ok(OctopusMergeResult {
                    merged_branches: Vec::new(),
                    failed_branches: vec![(branch.clone(), err.to_string())],
                }),
            };
        }
        let git_date = to_git_date(iso_date);
        self.run(&["checkout", HISTORY_BRANCH], Some(&git_date))
            .await?;
        let before = self.head_sha().await?;
        let mut args: Vec<&str> = vec!["merge", "--no-ff", "-m", message];
        for b in branches {
            args.push(b.as_str());
        }
        if self.run(&args, Some(&git_date)).await.is_ok() {
            self.record_commits_since(&before, &git_date).await?;
            return Ok(OctopusMergeResult {
                merged_branches: branches.to_vec(),
                failed_branches: Vec::new(),
            });
        }

        // Octopus can't take `-X ours`, so on conflict abort and fall back to
        // sequential two-parent merges. Each call goes through `merge_dl_branch`,
        // which itself retries with `-X ours` / `--allow-unrelated-histories`.
        self.abort_merge_if_any().await?;
        let mut result = OctopusMergeResult::default();
        for b in branches {
            match self.merge_dl_branch(b, message, iso_date).await {
                Ok(()) => result.merged_branches.push(b.clone()),
                Err(err) => result.failed_branches.push((b.clone(), err.to_string())),
            }
        }
        Ok(result)
    }

    /// Sync `git checkout main`, keeping the checkpoint file.
    pub fn checkout_main_sync(&self) {
        checkout_main_sync_for_repo(self.cwd(), &self.config.checkpoint_file);
    }
}

/// Ctrl-C is delivered to the whole foreground process group. Put git in its
/// own group so an in-flight add/commit/merge is not killed mid-write.
fn tokio_git() -> Command {
    let mut cmd = Command::new("git");
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

fn std_git() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

fn std_git_ok(cwd: &str, args: &[&str]) -> bool {
    std_git()
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn current_branch_sync(cwd: &str) -> Option<String> {
    let out = std_git()
        .current_dir(cwd)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() || name == "HEAD" {
        None
    } else {
        Some(name)
    }
}

/// `origin/<branch>` exists and there is no local branch of that name.
/// Create the local branch tracking it, without checking it out.
/// Returns whether a local branch exists afterwards.
fn ensure_local_tracking_branch(cwd: &str, branch: &str) -> Result<bool> {
    if local_branch_exists(cwd, branch) {
        return Ok(true);
    }
    let remote_ref = format!("refs/remotes/origin/{branch}");
    if !std_git_ok(cwd, &["show-ref", "--verify", "--quiet", &remote_ref]) {
        return Ok(false);
    }
    let start = format!("origin/{branch}");
    let out = std_git()
        .current_dir(cwd)
        .args(["branch", branch, &start])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("spawning git branch {branch} {start}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!("git branch {branch} {start} failed: {detail}"));
    }
    Ok(true)
}

fn local_branch_exists(cwd: &str, branch: &str) -> bool {
    let reference = format!("refs/heads/{branch}");
    std_git_ok(cwd, &["show-ref", "--verify", "--quiet", &reference])
}

fn origin_exists(cwd: &str) -> bool {
    std_git_ok(cwd, &["remote", "get-url", "origin"])
}

/// Push `args` (already including the remote name) when `origin` exists.
/// No `origin` is success. A rejected push is [`is_origin_push_failure`].
pub fn push_origin(cwd: &str, args: &[&str]) -> Result<()> {
    if !origin_exists(cwd) {
        return Ok(());
    }
    let out = std_git()
        .current_dir(cwd)
        .arg("push")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("spawning git push {args:?}"))?;
    if out.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(anyhow!("origin push failed: {detail}"))
}

pub fn is_origin_push_failure(err: &anyhow::Error) -> bool {
    err.chain()
        .any(|cause| cause.to_string().contains("origin push failed"))
}

/// Restore the source branch after a scrape. Aborts a half-finished merge
/// first; force-checkout is used only when we are *not* already on `main`,
/// so uncommitted edits on the source branch are kept. A checkpoint path
/// inside the repo is copied aside and written back, because `main` tracks
/// that file and a checkout would replace it with the last commit.
pub fn checkout_main_sync_for_repo(cwd: &str, checkpoint_file: &str) {
    let preserved = read_checkpoint_if_in_repo(cwd, checkpoint_file);
    let _ = std::fs::remove_file(Path::new(cwd).join(".git").join("index.lock"));
    let _ = std_git_ok(cwd, &["merge", "--abort"]);
    if current_branch_sync(cwd).as_deref() != Some(MAIN_BRANCH) {
        if !std_git_ok(cwd, &["checkout", MAIN_BRANCH]) {
            let _ = std_git_ok(cwd, &["checkout", "-f", MAIN_BRANCH]);
        }
    }
    if let Some(bytes) = preserved {
        let path = Path::new(cwd).join(checkpoint_file);
        let _ = std::fs::write(path, bytes);
    }
}

fn read_checkpoint_if_in_repo(cwd: &str, checkpoint_file: &str) -> Option<Vec<u8>> {
    let rel = Path::new(checkpoint_file);
    if checkpoint_file.is_empty() || rel.is_absolute() {
        return None;
    }
    std::fs::read(Path::new(cwd).join(rel)).ok()
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
    use std::path::Path;

    #[test]
    fn branch_name_for_has_no_rs_suffix() {
        assert_eq!(
            branch_name_for(BranchableShort::Dl, "077U0019"),
            "dl/077U0019"
        );
        assert_eq!(
            branch_name_for(BranchableShort::Dlcps, "046U0047"),
            "dlcps/046U0047"
        );
    }

    #[test]
    fn pre_epoch_clamps_to_zero() {
        assert_eq!(to_git_date("1861-01-01"), "@0 +0000");
    }

    #[test]
    fn commit_index_line_names_the_act_file() {
        let line = commit_index_line(
            "GU 1 - 2020-01-02 - LEGGE 020G0001",
            &[
                "legge-1-del-02-01-2020.txt",
                "legge-1-del-02-01-2020.txt.modifiedby",
                "legge-1-del-02-01-2020.allegato-1.txt",
            ],
        );
        assert_eq!(
            line,
            "GU 1 - 2020-01-02 - LEGGE 020G0001\tlegge-1-del-02-01-2020.txt\n"
        );
    }

    #[test]
    fn commit_index_line_skips_slug_when_two_act_files() {
        let line = commit_index_line("Modifica: LEGGE 020G0001 @ 2020-05-01", &["a.txt", "b.txt"]);
        assert_eq!(line, "Modifica: LEGGE 020G0001 @ 2020-05-01\n");
    }

    #[test]
    fn commit_index_line_ignores_non_naming_subjects() {
        let line = commit_index_line("Convertito in legge: L. 1/2020 (2020-02-01).", &["a.txt"]);
        assert_eq!(line, "Convertito in legge: L. 1/2020 (2020-02-01).\n");
    }

    #[test]
    fn name_only_log_becomes_index_lines() {
        let log = "\u{1e}GU 1 - 2020-01-02 - LEGGE 020G0001\n\na.txt\na.txt.modifiedby\n\n\u{1e}DECADUTO: DECRETO-LEGGE 2020 n. 1\n\n";
        assert_eq!(
            index_lines_from_name_only_log(log),
            "GU 1 - 2020-01-02 - LEGGE 020G0001\ta.txt\nDECADUTO: DECRETO-LEGGE 2020 n. 1\n"
        );
    }

    #[test]
    fn attach_net_slug_marks_the_last_naming_subject() {
        let lines = "GU 1 - 2020-01-02 - LEGGE 020G0001\nDECADUTO: DECRETO-LEGGE 2020 n. 1\n";
        assert_eq!(
            attach_net_slug(lines, "legge-1-del-02-01-2020.txt"),
            "GU 1 - 2020-01-02 - LEGGE 020G0001\tlegge-1-del-02-01-2020.txt\nDECADUTO: DECRETO-LEGGE 2020 n. 1\n"
        );
    }

    #[test]
    fn modern_iso_round_trips() {
        let s = to_git_date("2020-06-15");
        assert!(s.starts_with('@') && s.ends_with(" +0000"));
        let ts: i64 = s[1..s.len() - 6].parse().unwrap();
        assert!(ts > 1_500_000_000);
    }

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap()
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let out = git(dir, args);
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo_on_main(dir: &Path) {
        git_ok(dir, &["init"]);
        git_ok(dir, &["config", "user.email", "test@example.com"]);
        git_ok(dir, &["config", "user.name", "test"]);
        git_ok(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git_ok(dir, &["add", "a.txt"]);
        git_ok(dir, &["commit", "-m", "init"]);
        git_ok(dir, &["branch", "-M", MAIN_BRANCH]);
    }

    #[test]
    fn checkout_main_sync_preserves_dirty_files_on_main() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo_on_main(p);
        std::fs::write(p.join("a.txt"), "local-wip\n").unwrap();
        std::fs::write(p.join(".git").join("index.lock"), "stale").unwrap();

        checkout_main_sync_for_repo(p.to_str().unwrap(), "progress-rs.json");

        assert_eq!(
            current_branch_sync(p.to_str().unwrap()).as_deref(),
            Some(MAIN_BRANCH)
        );
        assert_eq!(
            std::fs::read_to_string(p.join("a.txt")).unwrap(),
            "local-wip\n"
        );
        assert!(!p.join(".git").join("index.lock").exists());
    }

    #[test]
    fn checkout_main_sync_recovers_from_merge_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo_on_main(p);
        git_ok(p, &["checkout", "-b", HISTORY_BRANCH]);
        std::fs::write(p.join("a.txt"), "history\n").unwrap();
        git_ok(p, &["commit", "-am", "history"]);
        git_ok(p, &["checkout", MAIN_BRANCH]);
        std::fs::write(p.join("a.txt"), "rust\n").unwrap();
        git_ok(p, &["commit", "-am", "rust"]);
        git_ok(p, &["checkout", HISTORY_BRANCH]);
        let merge = git(p, &["merge", MAIN_BRANCH]);
        assert!(!merge.status.success(), "expected a conflict");
        assert!(p.join(".git").join("MERGE_HEAD").exists());

        checkout_main_sync_for_repo(p.to_str().unwrap(), "progress-rs.json");

        assert_eq!(
            current_branch_sync(p.to_str().unwrap()).as_deref(),
            Some(MAIN_BRANCH)
        );
        assert!(!p.join(".git").join("MERGE_HEAD").exists());
    }

    fn head_sha(dir: &Path) -> String {
        let out = git(dir, &["rev-parse", "HEAD"]);
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn origin_history_becomes_a_local_branch_without_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo_on_main(p);
        git_ok(p, &["checkout", "-b", HISTORY_BRANCH]);
        std::fs::write(p.join("law.txt"), "testo\n").unwrap();
        git_ok(p, &["add", "law.txt"]);
        git_ok(p, &["commit", "-m", "law"]);
        let tip = head_sha(p);
        git_ok(p, &["checkout", MAIN_BRANCH]);
        git_ok(p, &["branch", "-D", HISTORY_BRANCH]);
        git_ok(p, &["update-ref", "refs/remotes/origin/history", &tip]);

        assert!(ensure_local_tracking_branch(p.to_str().unwrap(), HISTORY_BRANCH).unwrap());

        assert_eq!(
            current_branch_sync(p.to_str().unwrap()).as_deref(),
            Some(MAIN_BRANCH)
        );
        let local = git(p, &["rev-parse", HISTORY_BRANCH]);
        assert_eq!(String::from_utf8_lossy(&local.stdout).trim(), tip);
        let log = git(p, &["log", HISTORY_BRANCH, "--format=%s"]);
        let subjects = String::from_utf8_lossy(&log.stdout);
        assert!(
            !subjects.contains("initial history branch"),
            "adopted branch must not be a new orphan root, got {subjects}"
        );
    }

    #[test]
    fn origin_provisional_branch_becomes_local() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo_on_main(p);
        git_ok(p, &["checkout", "-b", "dl/EXAMPLE"]);
        std::fs::write(p.join("dl.txt"), "decreto\n").unwrap();
        git_ok(p, &["add", "dl.txt"]);
        git_ok(p, &["commit", "-m", "dl"]);
        let tip = head_sha(p);
        git_ok(p, &["checkout", MAIN_BRANCH]);
        git_ok(p, &["branch", "-D", "dl/EXAMPLE"]);
        git_ok(p, &["update-ref", "refs/remotes/origin/dl/EXAMPLE", &tip]);

        assert!(ensure_local_tracking_branch(p.to_str().unwrap(), "dl/EXAMPLE").unwrap());
        let local = git(p, &["rev-parse", "dl/EXAMPLE"]);
        assert_eq!(String::from_utf8_lossy(&local.stdout).trim(), tip);
    }

    #[test]
    fn checkout_main_sync_restores_checkpoint_from_history() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo_on_main(p);
        std::fs::write(p.join("progress-rs.json"), "old\n").unwrap();
        git_ok(p, &["add", "progress-rs.json"]);
        git_ok(p, &["commit", "-m", "checkpoint"]);
        git_ok(p, &["checkout", "-b", HISTORY_BRANCH]);
        std::fs::write(p.join("progress-rs.json"), "new\n").unwrap();

        checkout_main_sync_for_repo(p.to_str().unwrap(), "progress-rs.json");

        assert_eq!(
            current_branch_sync(p.to_str().unwrap()).as_deref(),
            Some(MAIN_BRANCH)
        );
        assert_eq!(
            std::fs::read_to_string(p.join("progress-rs.json")).unwrap(),
            "new\n"
        );
    }

    #[test]
    fn push_without_origin_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo_on_main(p);
        push_origin(p.to_str().unwrap(), &["origin", HISTORY_BRANCH]).unwrap();
        push_origin(p.to_str().unwrap(), &["-u", "origin", "dl/EXAMPLE"]).unwrap();
    }

    #[test]
    fn push_rejected_by_origin_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo_on_main(p);
        git_ok(p, &["remote", "add", "origin", "/nonexistent/repo.git"]);
        let err = push_origin(p.to_str().unwrap(), &["origin", HISTORY_BRANCH]).unwrap_err();
        assert!(is_origin_push_failure(&err), "{err}");
        let err = push_origin(p.to_str().unwrap(), &["-u", "origin", "dl/EXAMPLE"]).unwrap_err();
        assert!(is_origin_push_failure(&err), "{err}");
    }
}
