use std::path::PathBuf;

use anyhow::{Context, Result};
use tokio::fs;

use crate::types::{Checkpoint, Config};

fn checkpoint_path(config: &Config) -> PathBuf {
    PathBuf::from(&config.output_repo).join(&config.checkpoint_file)
}

pub async fn load_checkpoint(config: &Config) -> Result<Checkpoint> {
    let path = checkpoint_path(config);
    match fs::read_to_string(&path).await {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        Err(_) => Ok(Checkpoint::default()),
    }
}

/// Write atomically: write to a sibling `.tmp`, then rename over the target.
pub async fn save_checkpoint_atomic(config: &Config, cp: &Checkpoint) -> Result<()> {
    let target = checkpoint_path(config);
    let tmp = target.with_extension(format!(
        "{}.tmp",
        target
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("json")
    ));
    let body = serde_json::to_vec(cp).context("serializing checkpoint")?;
    fs::write(&tmp, body)
        .await
        .with_context(|| format!("writing temp checkpoint at {}", tmp.display()))?;
    fs::rename(&tmp, &target)
        .await
        .with_context(|| format!("renaming checkpoint into place at {}", target.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ActVersionEntry, Config};

    fn test_config(dir: &std::path::Path) -> Config {
        Config {
            api_base: String::new(),
            api_token: String::new(),
            output_repo: dir.to_string_lossy().into_owned(),
            author_name: "test".into(),
            author_email: "test@example.org".into(),
            github_repo: None,
            batch_size: 10,
            concurrency: 1,
            min_time_ms: 1,
            max_retries: 1,
            cache_ttl_sec: 1,
            checkpoint_file: "progress-rs.json".into(),
        }
    }

    #[tokio::test]
    async fn save_is_compact_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_config(dir.path());
        let mut cp = Checkpoint::default();
        cp.act_versions.insert(
            "ABC123".into(),
            ActVersionEntry {
                date: "1861-01-01".into(),
                ..Default::default()
            },
        );

        save_checkpoint_atomic(&config, &cp).await.unwrap();

        let raw = fs::read_to_string(dir.path().join("progress-rs.json"))
            .await
            .unwrap();
        assert!(
            !raw.contains("{\n  "),
            "checkpoint must be compact JSON, got {raw}"
        );

        let loaded = load_checkpoint(&config).await.unwrap();
        assert_eq!(
            loaded.act_versions.get("ABC123").map(|e| e.date.as_str()),
            Some("1861-01-01")
        );
    }
}
