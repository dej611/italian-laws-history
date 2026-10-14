use std::env;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::NaiveDate;
use tokio::process::Command;

use crate::git::HISTORY_BRANCH;
use crate::types::{Config, PendingAct};

/// GitHub PR helpers via `gh`. All methods are no-ops when `GITHUB_REPO` /
/// `GITHUB_REPOSITORY` is unset or no `GH_TOKEN`/`GITHUB_TOKEN` is present, so
/// local runs against a throwaway `OUTPUT_REPO` do not talk to GitHub.
pub struct GithubHelpers {
    config: Arc<Config>,
}

impl GithubHelpers {
    pub fn new(config: Arc<Config>) -> Self {
        Self { config }
    }

    pub fn enabled(&self) -> bool {
        self.repo().is_some() && github_token_present()
    }

    fn repo(&self) -> Option<&str> {
        self.config.github_repo.as_deref()
    }

    /// Open a PR of `branch` into `history` if none exists yet.
    /// Returns `true` when a new PR was created.
    pub async fn ensure_pr(&self, branch: &str, title: &str, body: &str) -> Result<bool> {
        if !self.enabled() {
            return Ok(false);
        }
        match self.pr_exists(branch).await {
            Ok(true) => return Ok(false),
            Ok(false) => {}
            Err(err) if is_gh_missing(&err) => return Ok(false),
            Err(err) => return Err(err),
        }
        let repo = self.repo().expect("enabled implies repo");
        match self
            .run(&[
                "pr",
                "create",
                "-R",
                repo,
                "--base",
                HISTORY_BRANCH,
                "--head",
                branch,
                "--title",
                title,
                "--body",
                body,
            ])
            .await
        {
            Ok(()) => Ok(true),
            Err(err) if is_gh_missing(&err) => Ok(false),
            Err(err) => Err(err),
        }
    }

    pub async fn comment_pr(&self, branch: &str, body: &str) -> Result<()> {
        if !self.enabled() {
            return Ok(());
        }
        let repo = self.repo().expect("enabled implies repo");
        match self
            .run(&["pr", "comment", branch, "-R", repo, "--body", body])
            .await
        {
            Ok(()) => Ok(()),
            Err(err) if is_gh_missing(&err) => Ok(()),
            Err(err) => Err(err),
        }
    }

    async fn pr_exists(&self, branch: &str) -> Result<bool> {
        let repo = self.repo().expect("enabled implies repo");
        let head = head_filter(repo, branch);
        let json = match self
            .run_capture(&[
                "pr",
                "list",
                "-R",
                repo,
                "--head",
                &head,
                "--base",
                HISTORY_BRANCH,
                "--state",
                "all",
                "--limit",
                "1",
                "--json",
                "number",
            ])
            .await
        {
            Ok(s) => s,
            Err(err) if is_gh_missing(&err) => return Ok(false),
            Err(err) => return Err(err),
        };
        let prs: Vec<serde_json::Value> = serde_json::from_str(json.trim()).unwrap_or_default();
        Ok(!prs.is_empty())
    }

    async fn run(&self, args: &[&str]) -> Result<()> {
        let out = spawn_gh(args).await?;
        if !out.status.success() {
            return Err(anyhow!(
                "gh {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    async fn run_capture(&self, args: &[&str]) -> Result<String> {
        let out = spawn_gh(args).await?;
        if !out.status.success() {
            return Err(anyhow!(
                "gh {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }
}

async fn spawn_gh(args: &[&str]) -> Result<std::process::Output> {
    Command::new("gh")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                anyhow!("gh not found")
            } else {
                anyhow!("spawning gh {args:?}: {err}")
            }
        })
}

fn is_gh_missing(err: &anyhow::Error) -> bool {
    err.to_string().contains("gh not found")
}

fn github_token_present() -> bool {
    env_nonempty("GH_TOKEN") || env_nonempty("GITHUB_TOKEN")
}

fn env_nonempty(key: &str) -> bool {
    env::var(key).ok().filter(|s| !s.is_empty()).is_some()
}

/// GitHub's `head` filter wants `owner:branch`.
fn head_filter(repo: &str, branch: &str) -> String {
    match repo.split_once('/') {
        Some((owner, _)) => format!("{owner}:{branch}"),
        None => branch.to_string(),
    }
}

pub fn pr_title(act: &PendingAct) -> String {
    let tag = act.short.upper();
    format!("{tag} {} — attesa conversione", act.codice_redazionale)
}

pub fn open_pr_body(act: &PendingAct) -> String {
    let denom = act
        .denominazione_atto
        .as_deref()
        .unwrap_or(act.short.pretty());
    let mut lines = vec![
        "Atto provvisorio in attesa di conversione.".into(),
        String::new(),
        format!("- Tipo: {denom}"),
        format!("- Codice: {}", act.codice_redazionale),
        format!("- Data GU: {}", iso10(&act.data_gu)),
    ];
    if let Some(num) = act.numero_provvedimento.as_deref() {
        let year = act.anno_provvedimento.as_deref().unwrap_or("?");
        lines.push(format!("- Numero: {num}/{year}"));
    }
    match act.deadline_days {
        Some(days) => {
            let due = add_days(&iso10(&act.data_gu), days).unwrap_or_else(|| "?".into());
            lines.push(format!("- Termine: {days} giorni (scade il {due})"));
        }
        None => lines.push("- Termine: nessuno (attesa ratifica)".into()),
    }
    lines.join("\n")
}

pub fn converted_comment(label: &str, merge_date: &str) -> String {
    format!("Convertito in legge: {label} ({merge_date}).")
}

pub fn decaduto_comment(act: &PendingAct, due_date: &str) -> String {
    let denom = act
        .denominazione_atto
        .as_deref()
        .unwrap_or(act.short.pretty());
    let year = act.anno_provvedimento.as_deref().unwrap_or("");
    let num = act
        .numero_provvedimento
        .as_deref()
        .unwrap_or(&act.codice_redazionale);
    match act.deadline_days {
        Some(days) => format!(
            "DECADUTO: {denom} {year} n. {num} — termine di {days} giorni scaduto il {due_date} senza conversione."
        ),
        None => format!(
            "DECADUTO: {denom} {year} n. {num} — abrogato il {due_date} (nessun termine automatico di decadenza)."
        ),
    }
}

pub fn sanatoria_comment(label: &str, publication_date: &str) -> String {
    format!("Ratificato da {label} il {publication_date}.")
}

pub fn migration_comment(merge_date: &str) -> String {
    format!("Merge su history ({merge_date}): decreto-legge luogotenenziale fuori cohort 1944–46.")
}

pub fn add_days(iso: &str, days: u32) -> Option<String> {
    let date = NaiveDate::parse_from_str(iso10(iso).as_str(), "%Y-%m-%d").ok()?;
    Some(
        (date + chrono::Duration::days(i64::from(days)))
            .format("%Y-%m-%d")
            .to_string(),
    )
}

fn iso10(s: &str) -> String {
    s.get(0..10).unwrap_or(s).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::BranchableShort;

    fn dl_act() -> PendingAct {
        PendingAct {
            codice_redazionale: "077U0019".into(),
            branch_name: "dl/077U0019".into(),
            data_gu: "2024-01-15".into(),
            denominazione_atto: Some("DECRETO-LEGGE".into()),
            numero_provvedimento: Some("19".into()),
            anno_provvedimento: Some("2024".into()),
            mese_provvedimento: Some("1".into()),
            giorno_provvedimento: Some("15".into()),
            short: BranchableShort::Dl,
            deadline_days: Some(60),
        }
    }

    #[test]
    fn add_days_dl_60() {
        assert_eq!(add_days("2024-01-15", 60).as_deref(), Some("2024-03-15"));
    }

    #[test]
    fn add_days_strips_datetime_prefix() {
        assert_eq!(
            add_days("2024-01-15T00:00:00Z", 60).as_deref(),
            Some("2024-03-15")
        );
    }

    #[test]
    fn pr_title_uses_short_tag() {
        assert_eq!(pr_title(&dl_act()), "DL 077U0019 — attesa conversione");
    }

    #[test]
    fn open_pr_body_includes_deadline() {
        let body = open_pr_body(&dl_act());
        assert!(body.contains("Codice: 077U0019"));
        assert!(body.contains("Termine: 60 giorni (scade il 2024-03-15)"));
        assert!(body.contains("Numero: 19/2024"));
    }

    #[test]
    fn open_pr_body_no_deadline() {
        let mut act = dl_act();
        act.short = BranchableShort::Dlcps;
        act.deadline_days = None;
        let body = open_pr_body(&act);
        assert!(body.contains("Termine: nessuno (attesa ratifica)"));
    }

    #[test]
    fn decaduto_comment_includes_due_date() {
        let text = decaduto_comment(&dl_act(), "2024-03-15");
        assert!(text.contains("DECADUTO"));
        assert!(text.contains("60 giorni"));
        assert!(text.contains("2024-03-15"));
        assert!(text.contains("senza conversione"));
    }

    #[test]
    fn decaduto_comment_abrogated_without_deadline() {
        let mut act = dl_act();
        act.deadline_days = None;
        let text = decaduto_comment(&act, "1956-04-17");
        assert!(text.contains("abrogato il 1956-04-17"));
        assert!(!text.contains("giorni scaduto"));
    }

    #[test]
    fn converted_and_sanatoria_comments() {
        assert_eq!(
            converted_comment("LEGGE 15 marzo 2024 n. 20", "2024-03-15"),
            "Convertito in legge: LEGGE 15 marzo 2024 n. 20 (2024-03-15)."
        );
        assert_eq!(
            sanatoria_comment("L. 561/1956", "1956-04-17"),
            "Ratificato da L. 561/1956 il 1956-04-17."
        );
    }

    #[test]
    fn head_filter_prefixes_owner() {
        assert_eq!(head_filter("acme/laws", "dl/077U0019"), "acme:dl/077U0019");
    }
}
