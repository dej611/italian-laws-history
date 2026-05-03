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
        target.extension().and_then(|s| s.to_str()).unwrap_or("json")
    ));
    let body = serde_json::to_vec_pretty(cp).context("serializing checkpoint")?;
    fs::write(&tmp, body)
        .await
        .with_context(|| format!("writing temp checkpoint at {}", tmp.display()))?;
    fs::rename(&tmp, &target)
        .await
        .with_context(|| format!("renaming checkpoint into place at {}", target.display()))?;
    Ok(())
}
