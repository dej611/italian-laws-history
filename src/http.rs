use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Result};
use governor::clock::DefaultClock;
use governor::middleware::NoOpMiddleware;
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter};
use moka::sync::Cache;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use reqwest::{Client, Method};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::time::sleep;

use crate::logger::Logger;
use crate::types::Config;

type AppRateLimiter = RateLimiter<
    NotKeyed,
    InMemoryState,
    DefaultClock,
    NoOpMiddleware<governor::clock::QuantaInstant>,
>;

/// Extra attempts beyond `max_retries` for connect/reset/timeout transport errors.
/// Allegato probing roughly doubles request volume; Normattiva often answers with
/// RST under sustained load, which is transient and worth waiting out.
const TRANSPORT_EXTRA_RETRIES: u32 = 5;

/// Per-attempt ceiling. Logs showed a 1→32s ladder (~66s) on every
/// `ricerca/avanzata` RST; that serialized the whole scrape.
const TRANSPORT_BACKOFF_CAP_MS: u64 = 8_000;

/// `safeFetch` Rust port: per-request semaphore + min-time pacing + TTL cache
/// + exponential backoff for 429/5xx (with `Retry-After` honoured) + 30s timeout
/// + recursive retry up to `max_retries` (more for transport/connect errors).
pub struct SafeFetch {
    client: Client,
    sem: Arc<Semaphore>,
    rate: Arc<AppRateLimiter>,
    cache: Cache<String, Vec<u8>>,
    max_retries: u32,
    logger: Arc<dyn Logger>,
    api_token: String,
}

impl SafeFetch {
    pub fn new(config: Arc<Config>, logger: Arc<dyn Logger>) -> Result<Self> {
        // No idle keep-alive pool: Normattiva frequently RSTs reused sockets
        // under allegato-era load ("Connection reset by peer" on the next POST).
        // Custom TLS config: the server omits the issuing intermediate, which
        // rustls rejects as UnknownIssuer unless we fetch it (see `tls`).
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(0)
            .tcp_keepalive(Duration::from_secs(30))
            .gzip(true)
            .use_preconfigured_tls(crate::tls::client_config()?)
            .build()?;

        let sem = Arc::new(Semaphore::new(config.concurrency.max(1) as usize));

        // governor `Quota::with_period` rejects zero — clamp to 1ms.
        let period = Duration::from_millis(config.min_time_ms.max(1));
        let quota = Quota::with_period(period)
            .ok_or_else(|| anyhow!("invalid MIN_TIME_MS"))?
            .allow_burst(NonZeroU32::new(1).unwrap());
        let rate = Arc::new(RateLimiter::direct(quota));

        let cache: Cache<String, Vec<u8>> = Cache::builder()
            .time_to_live(Duration::from_secs(config.cache_ttl_sec))
            .max_capacity(50_000)
            .build();

        Ok(Self {
            client,
            sem,
            rate,
            cache,
            max_retries: config.max_retries,
            logger,
            api_token: config.api_token.clone(),
        })
    }

    /// Issue a JSON POST and decode the response as `T`.
    /// `body` is serialised once and used as part of the cache key.
    pub async fn post_json<T: DeserializeOwned>(&self, url: &str, body: &Value) -> Result<T> {
        let body_str = serde_json::to_string(body)?;
        let bytes = self.fetch(Method::POST, url, Some(body_str)).await?;
        Ok(serde_json::from_slice::<T>(&bytes)?)
    }

    /// Core entry point: returns the raw response bytes. Mirrors the TS
    /// `safeFetch` shape with cache-by-(url + body) semantics.
    pub async fn fetch(&self, method: Method, url: &str, body: Option<String>) -> Result<Vec<u8>> {
        self.fetch_inner(method, url, body, 0).await
    }

    fn cache_key(method: &Method, url: &str, body: &Option<String>) -> String {
        // Match TS: `${url}|${JSON.stringify(opts)}` where opts includes method+headers+body.
        // We approximate by `method|url|body` — equivalent for our call sites
        // (only POST-with-body and GET are used; headers are constant per run).
        let body_part = body.as_deref().unwrap_or("");
        format!("{method}|{url}|{body_part}")
    }

    fn build_headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if !self.api_token.is_empty() {
            if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", self.api_token)) {
                h.insert(AUTHORIZATION, v);
            }
        }
        h
    }

    fn fetch_inner<'a>(
        &'a self,
        method: Method,
        url: &'a str,
        body: Option<String>,
        attempt: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>>> + Send + 'a>> {
        Box::pin(async move {
            let key = Self::cache_key(&method, url, &body);
            if let Some(hit) = self.cache.get(&key) {
                return Ok(hit);
            }

            // Hold the permit through body read. Releasing after `send()` let
            // other tasks open extra sockets while responses were still streaming,
            // blowing past CONCURRENCY and triggering peer RSTs.
            let permit = self.sem.acquire().await.map_err(|e| anyhow!(e))?;
            self.rate.until_ready().await;

            let mut req = self
                .client
                .request(method.clone(), url)
                .headers(self.build_headers());
            if let Some(b) = &body {
                req = req.body(b.clone());
            }

            let res = match req.send().await {
                Ok(r) => r,
                Err(err) => {
                    drop(permit);
                    return self
                        .handle_transport_error(method, url, body, attempt, err)
                        .await;
                }
            };

            let status = res.status();
            if status.as_u16() == 429 || status.is_server_error() {
                let retry_after = res
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_retry_after);
                drop(permit);

                if attempt < self.max_retries {
                    let wait = retry_after
                        .unwrap_or_else(|| Duration::from_millis(2u64.pow(attempt) * 1000));
                    self.logger.log(&format!(
                        "Ricevuto {} per {url}, retry in {}ms",
                        status.as_u16(),
                        wait.as_millis()
                    ));
                    sleep(wait).await;
                    return self.fetch_inner(method, url, body, attempt + 1).await;
                }
                return Err(anyhow!("Max retries for {url}"));
            }

            // Body read can also hit "connection reset by peer" after headers.
            let bytes = match res.bytes().await {
                Ok(b) => b.to_vec(),
                Err(err) => {
                    drop(permit);
                    return self
                        .handle_transport_error(method, url, body, attempt, err)
                        .await;
                }
            };
            drop(permit);
            // 404 is a routine sentinel for end-of-articles probing and missing
            // cross-references — keep it out of the foreground log to avoid
            // burying real errors in the noise.
            if status.as_u16() == 404 {
                self.logger
                    .log_file(&format!("[fetch] {} {url}", status.as_u16()));
            } else {
                self.logger
                    .log(&format!("[fetch] {} {url}", status.as_u16()));
            }
            self.logger
                .log_file(&format!("[curl] {}", to_curl(&method, url, &body)));
            // Only cache successful responses. Caching 4xx bodies for the
            // configured TTL (default 1h) poisoned subsequent retries with
            // stale "not found" results.
            if status.is_success() {
                self.cache.insert(key, bytes.clone());
            }
            Ok(bytes)
        })
    }

    async fn handle_transport_error(
        &self,
        method: Method,
        url: &str,
        body: Option<String>,
        attempt: u32,
        err: reqwest::Error,
    ) -> Result<Vec<u8>> {
        let limit = if is_transient_transport(&err) {
            self.max_retries.saturating_add(TRANSPORT_EXTRA_RETRIES)
        } else {
            self.max_retries
        };
        if attempt < limit {
            let wait = transport_backoff(attempt);
            self.logger.log(&format!(
                "Errore fetch {url}: {}. Retry in {}ms",
                error_with_sources(&err),
                wait.as_millis()
            ));
            sleep(wait).await;
            return self.fetch_inner(method, url, body, attempt + 1).await;
        }
        Err(anyhow!(error_with_sources(&err)))
    }
}

/// reqwest's `Display` is only "error sending request for url (...)".
/// The certificate or reset reason lives on the `source` chain.
fn error_with_sources(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut src = err.source();
    while let Some(cause) = src {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        src = cause.source();
    }
    out
}

/// Connect / timeout / request-send failures worth waiting out (vs. e.g. bad URL).
fn is_transient_transport(err: &reqwest::Error) -> bool {
    if err.is_timeout() || err.is_connect() || err.is_request() {
        return true;
    }
    // Hyper sometimes wraps RST without setting the connect flag.
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("connection reset")
        || msg.contains("broken pipe")
        || msg.contains("connection refused")
        || msg.contains("temporarily unavailable")
        || msg.contains("error sending request")
}

/// Exponential backoff with light jitter, capped at [`TRANSPORT_BACKOFF_CAP_MS`].
fn transport_backoff(attempt: u32) -> Duration {
    let exp = attempt.min(3); // 1s, 2s, 4s, then cap
    let base_ms = (2u64.pow(exp) * 1000).min(TRANSPORT_BACKOFF_CAP_MS);
    // Deterministic jitter from attempt so tests stay stable and we still
    // desynchronise concurrent waiters somewhat.
    let jitter_ms = (u64::from(attempt).wrapping_mul(173) % (base_ms / 4 + 1)).min(base_ms / 2);
    Duration::from_millis((base_ms + jitter_ms).min(TRANSPORT_BACKOFF_CAP_MS))
}

/// Parse `Retry-After` as either a delta-seconds integer OR an HTTP-date.
/// (TS only handled the seconds form; the Rust port is a strict superset.)
fn parse_retry_after(raw: &str) -> Option<Duration> {
    let trimmed = raw.trim();
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    if let Ok(date) = httpdate::parse_http_date(trimmed) {
        let now = SystemTime::now();
        if let Ok(d) = date.duration_since(now) {
            return Some(d);
        }
    }
    None
}

fn to_curl(method: &Method, url: &str, body: &Option<String>) -> String {
    let mut parts = vec![
        format!("curl -X '{method}'"),
        "-H 'Content-Type: application/json'".to_string(),
    ];
    if let Some(b) = body {
        parts.push(format!("-d '{}'", b.replace('\'', "'\\''")));
    }
    parts.push(format!("'{url}'"));
    parts.join(" \\\n  ")
}

#[cfg(test)]
mod tests {
    use super::{parse_retry_after, transport_backoff};
    use std::time::Duration;

    #[test]
    fn retry_after_seconds() {
        assert_eq!(parse_retry_after("30"), Some(Duration::from_secs(30)));
        assert_eq!(parse_retry_after(" 7 "), Some(Duration::from_secs(7)));
    }

    #[test]
    fn retry_after_invalid_returns_none() {
        assert!(parse_retry_after("not-a-date").is_none());
    }

    #[test]
    fn transport_backoff_grows_then_caps_exp() {
        assert!(transport_backoff(0) >= Duration::from_secs(1));
        assert!(transport_backoff(1) >= Duration::from_secs(2));
        assert!(transport_backoff(3) <= Duration::from_secs(8));
        assert!(transport_backoff(20) <= Duration::from_secs(8));
    }
}
