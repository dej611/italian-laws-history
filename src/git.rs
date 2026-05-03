use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, NaiveDate, Utc};
use tokio::process::Command;

use crate::types::Config;

/// The data branch this Rust port writes to (sibling of the TS port's `history`).
pub const HISTORY_BRANCH: &str = "history-rs";

/// The "home" branch the script lives on. Mirrors the TS code's safety
/// `git checkout main` calls — for the Rust port this is `rust`.
pub const MAIN_BRANCH: &str = "rust";

/// Prefix for provisional Decreto-Legge branches. Namespace-isolated from
/// the TS port's `dl/...` so the two implementations can coexist.
pub const DL_BRANCH_PREFIX: &str = "dl-rs/";

pub fn dl_branch_name(codice: &str) -> String {
    format!("{DL_BRANCH_PREFIX}{codice}")
}

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
            self.run(&["commit", "--allow-empty", "-m", "initial empty history"], None)
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

    #[tracing::instrument(skip(self))]
    pub async fn merge_dl_branch(
        &self,
        branch: &str,
        message: &str,
        iso_date: &str,
    ) -> Result<()> {
        let git_date = to_git_date(iso_date);
        self.run(&["checkout", HISTORY_BRANCH], Some(&git_date)).await?;
        self.run(&["merge", "--no-ff", branch, "-m", message], Some(&git_date))
            .await
    }

    /// Best-effort sync `git checkout rust`. Used from `Drop`/cleanup paths.
    /// Mirrors the TS `checkoutMainSync` (which targeted `main`).
    pub fn checkout_main_sync(&self) {
        let _ = std::process::Command::new("git")
            .current_dir(self.cwd())
            .args(["checkout", MAIN_BRANCH])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
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
