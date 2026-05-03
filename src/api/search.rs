use std::sync::Arc;

use async_stream::stream;
use chrono::NaiveDate;
use futures::Stream;
use serde_json::json;

use crate::http::SafeFetch;
use crate::logger::Logger;
use crate::types::{Config, NormattivaAtto, RicercaResponse};

/// Format a UTC date as ISO-8601 with the JS `toISOString()` shape.
/// Normattiva accepts both `YYYY-MM-DD` and full RFC-3339; we replicate
/// the TS output (`YYYY-MM-DDT00:00:00.000Z`) byte-for-byte to keep the
/// cache key identical across runs.
fn iso_z(d: NaiveDate) -> String {
    format!("{}T00:00:00.000Z", d.format("%Y-%m-%d"))
}

async fn fetch_acts_page(
    from: NaiveDate,
    to: NaiveDate,
    page: u32,
    config: &Config,
    sf: &SafeFetch,
) -> anyhow::Result<(Vec<NormattivaAtto>, u32)> {
    let url = format!("{}/api/v1/ricerca/avanzata", config.api_base);
    let body = json!({
        "dataInizioPubProvvedimento": iso_z(from),
        "dataFinePubProvvedimento": iso_z(to),
        "paginazione": {
            "paginaCorrente": page,
            "numeroElementiPerPagina": config.batch_size,
        },
    });
    let res: RicercaResponse = sf.post_json(&url, &body).await?;
    Ok((res.lista_atti.unwrap_or_default(), res.numero_pagine.unwrap_or(1)))
}

/// Async stream that paginates a single `[from, to)` window, yielding each
/// page's batch of acts.
pub fn scrape_month(
    from: NaiveDate,
    to: NaiveDate,
    config: Arc<Config>,
    sf: Arc<SafeFetch>,
    logger: Arc<dyn Logger>,
) -> impl Stream<Item = anyhow::Result<Vec<NormattivaAtto>>> {
    stream! {
        let label = format!("{}-{:02}", from.year_ce().1, from.format("%m"));
        let mut page: u32 = 0;
        let mut total_pages: u32 = 1;

        while page < total_pages {
            let _span = tracing::info_span!("api", op = "scrapeMonth:page", window = %label, page).entered();
            match fetch_acts_page(from, to, page, &config, &sf).await {
                Ok((acts, tp)) => {
                    total_pages = tp;
                    if acts.is_empty() { break; }
                    logger.log(&format!(
                        "Finestra {label} — pagina {}/{}, {} atti",
                        page + 1, total_pages, acts.len()
                    ));
                    yield Ok(acts);
                    page += 1;
                }
                Err(e) => {
                    yield Err(e);
                    return;
                }
            }
        }

        if page == 0 {
            logger.log(&format!("Finestra {label} — nessun atto trovato."));
        }
    }
}

/// Walk every monthly window from `since_date` to today and yield each page's
/// batch of acts. Mirrors the TS `scrapeActs` async generator (currently
/// unused by `main.rs`, which iterates windows itself, but kept for parity).
#[allow(dead_code)]
pub fn scrape_acts(
    since_date: String,
    config: Arc<Config>,
    sf: Arc<SafeFetch>,
    logger: Arc<dyn Logger>,
) -> impl Stream<Item = anyhow::Result<Vec<NormattivaAtto>>> {
    use crate::api::windows::monthly_windows;
    stream! {
        let windows = match monthly_windows(&since_date) {
            Ok(w) => w,
            Err(e) => { yield Err(e); return; }
        };
        for (from, to) in windows {
            let inner = scrape_month(from, to, config.clone(), sf.clone(), logger.clone());
            tokio::pin!(inner);
            use tokio_stream::StreamExt;
            while let Some(item) = inner.next().await {
                yield item;
            }
        }
    }
}

/// POST /api/v1/ricerca/aggiornati — paginated. Returns every act updated in
/// `[from, to)`. On error, returns whatever was gathered so far (TS parity).
pub async fn fetch_updated_acts(
    from: NaiveDate,
    to: NaiveDate,
    config: &Config,
    sf: &SafeFetch,
    logger: &dyn Logger,
) -> Vec<NormattivaAtto> {
    let _span = tracing::info_span!("api", op = "fetchUpdatedActs",
        from = %from, to = %to).entered();
    let url = format!("{}/api/v1/ricerca/aggiornati", config.api_base);
    let mut acts: Vec<NormattivaAtto> = Vec::new();
    let mut page: u32 = 0;
    let mut total_pages: u32 = 1;

    while page < total_pages {
        let body = json!({
            "dataInizioAggiornamento": iso_z(from),
            "dataFineAggiornamento": iso_z(to),
            "paginazione": {
                "paginaCorrente": page,
                "numeroElementiPerPagina": config.batch_size,
            },
        });
        match sf.post_json::<RicercaResponse>(&url, &body).await {
            Ok(res) => {
                total_pages = res.numero_pagine.unwrap_or(1);
                let batch = res.lista_atti.unwrap_or_default();
                if batch.is_empty() { break; }
                acts.extend(batch);
                page += 1;
            }
            Err(err) => {
                logger.log(&format!(
                    "fetchUpdatedActs fallito [{from} – {to}]: {err}"
                ));
                return acts;
            }
        }
    }
    acts
}

trait NaiveDateYearCe {
    fn year_ce(&self) -> (bool, u32);
}
impl NaiveDateYearCe for NaiveDate {
    fn year_ce(&self) -> (bool, u32) { chrono::Datelike::year_ce(self) }
}
