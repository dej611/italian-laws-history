use std::env;

use crate::types::Config;

fn env_str(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_opt(key: &str) -> Option<String> {
    env::var(key).ok().filter(|s| !s.is_empty())
}

fn env_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

pub fn load_config() -> Config {
    Config {
        api_base: env_str(
            "NORMATTIVA_API_BASE",
            "https://api.normattiva.it/t/normattiva.api/bff-opendata/v1",
        ),
        api_token: env_str("NORMATTIVA_API_TOKEN", ""),
        output_repo: env_str("OUTPUT_REPO", "./"),
        author_name: env_str("GIT_AUTHOR_NAME", "GU Bot"),
        author_email: env_str("GIT_AUTHOR_EMAIL", "gu-bot@example.org"),
        github_repo: env_opt("GITHUB_REPO"),
        batch_size: env_num("BATCH_SIZE", 10),
        concurrency: env_num("CONCURRENCY", 3),
        min_time_ms: env_num("MIN_TIME_MS", 300),
        max_retries: env_num("MAX_RETRIES", 5),
        cache_ttl_sec: env_num("CACHE_TTL_SEC", 3600),
        // Default differs from TS (`progress.json`) so the Rust port doesn't
        // collide with the existing Node version's checkpoint.
        checkpoint_file: env_str("CHECKPOINT_FILE", "progress-rs.json"),
    }
}
