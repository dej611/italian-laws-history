use serde_json::{json, Value};

use crate::api::text::build_act_urn;
use crate::http::SafeFetch;
use crate::logger::Logger;
use crate::types::{
    ActStatus, AttoDto, Config, DettaglioAttoResponse, NormattivaAtto, RicercaResponse,
};

// Used by the (currently unreferenced) `fetch_full_act_text` helper, retained
// for parity with the TS port's public surface.
#[allow(dead_code)]
const MAX_ARTICLES: u32 = 500;
#[allow(dead_code)]
const MAX_ALLEGATI_GROUPS: u32 = 20;

/// Fetch the text of an act at a specific version.
///
/// Prefers the URN endpoint (`dettaglio-atto-urn`) with a version suffix
/// (`@originale` or `!vig=YYYY-MM-DD`); falls back to the legacy
/// `dettaglio-atto` endpoint when a URN cannot be built from act metadata.
pub async fn fetch_act_detail(
    act: &NormattivaAtto,
    at_date: &str,
    config: &Config,
    sf: &SafeFetch,
    logger: &dyn Logger,
    version_suffix: &str,
) -> Option<AttoDto> {
    if let Some(base) = build_act_urn(act) {
        let urn = format!("{base}{version_suffix}");
        return fetch_act_detail_by_urn(&urn, config, sf, logger).await;
    }

    logger.log(&format!(
        "Impossibile costruire URN per {}, uso endpoint legacy",
        act.codice_redazionale
    ));
    let url = format!("{}/api/v1/atto/dettaglio-atto", config.api_base);

    let mut body = json!({
        "codiceRedazionale": act.codice_redazionale,
        "dataGU": act.data_gu,
        "tipoDettaglio": "multivigenza",
        "dataVigenza": at_date,
    });
    if let Some(num) = act.numero_supplemento.as_deref().and_then(|s| s.parse::<u64>().ok()) {
        if num > 0 {
            body["numeroSupplemento"] = Value::from(num);
        }
    }

    match sf.post_json::<DettaglioAttoResponse>(&url, &body).await {
        Ok(res) => {
            let atto = res.data.and_then(|d| d.atto);
            if !res.success.unwrap_or(false) || atto.is_none() {
                logger.log(&format!(
                    "Nessun dettaglio per {}: {}",
                    act.codice_redazionale,
                    res.message.unwrap_or_else(|| "risposta vuota".into())
                ));
                return None;
            }
            atto
        }
        Err(err) => {
            logger.log(&format!(
                "Dettaglio atto fallito per {} @ {}: {err}",
                act.codice_redazionale, at_date
            ));
            None
        }
    }
}

/// POST /api/v1/atto/dettaglio-atto-urn — preferred endpoint for versioned text.
pub async fn fetch_act_detail_by_urn(
    urn: &str,
    config: &Config,
    sf: &SafeFetch,
    logger: &dyn Logger,
) -> Option<AttoDto> {
    let url = format!("{}/api/v1/atto/dettaglio-atto-urn", config.api_base);
    let body = json!({ "urn": urn });

    match sf.post_json::<DettaglioAttoResponse>(&url, &body).await {
        Ok(res) => {
            let atto = res.data.and_then(|d| d.atto);
            if !res.success.unwrap_or(false) || atto.is_none() {
                logger.log(&format!(
                    "Nessun dettaglio per URN {urn}: {}",
                    res.message.unwrap_or_else(|| "risposta vuota".into())
                ));
                return None;
            }
            atto
        }
        Err(err) => {
            logger.log(&format!("Dettaglio atto fallito per URN {urn}: {err}"));
            None
        }
    }
}

/// Single-article probe: idArticolo + idGruppo. None = end-of-group / not found.
#[allow(dead_code)]
async fn fetch_article(
    act: &NormattivaAtto,
    at_date: &str,
    id_articolo: u32,
    id_gruppo: u32,
    config: &Config,
    sf: &SafeFetch,
) -> Option<AttoDto> {
    let url = format!("{}/api/v1/atto/dettaglio-atto", config.api_base);
    let mut body = json!({
        "codiceRedazionale": act.codice_redazionale,
        "dataGU": act.data_gu,
        "idArticolo": id_articolo,
        "sottoArticolo": 0,
        "sottoArticolo1": 0,
        "dataVigenza": at_date,
        "idGruppo": id_gruppo,
        "progressivo": 0,
        "versione": 0,
    });
    if let Some(num) = act.numero_supplemento.as_deref().and_then(|s| s.parse::<u64>().ok()) {
        if num > 0 {
            body["numeroSupplemento"] = Value::from(num);
        }
    }
    let res = sf.post_json::<DettaglioAttoResponse>(&url, &body).await.ok()?;
    if !res.success.unwrap_or(false) {
        return None;
    }
    let data = res.data?;
    if data.message.as_deref() == Some("Atto non trovato") {
        return None;
    }
    data.atto
}

/// Sequentially probe articles 0..N within a single idGruppo until the API
/// returns None. Returns the HTML strings of the articles that exist.
#[allow(dead_code)]
async fn fetch_article_group(
    act: &NormattivaAtto,
    at_date: &str,
    gruppo: u32,
    config: &Config,
    sf: &SafeFetch,
) -> Vec<String> {
    let mut parts = Vec::new();
    for art in 0..=MAX_ARTICLES {
        let Some(atto) = fetch_article(act, at_date, art, gruppo, config, sf).await else { break };
        let html = atto.testo_in_vigore.or(atto.articolo_html).unwrap_or_default();
        if !html.is_empty() {
            parts.push(html);
        }
    }
    parts
}

/// Concatenate the act's main body (gruppo=0) + every allegato group (1..N)
/// into one raw HTML string. Returns `None` when the act yields no text.
///
/// Concurrency: the main body is sequential; allegati groups are fanned out
/// in parallel, gated by the caller-provided `concurrency_limit` (mirrors the
/// TS `queue` parameter). Within each group, articles are still sequential.
///
/// Currently unused by the processor (which calls `fetch_act_detail` directly,
/// matching the TS code path), but kept for parity with the TS public API.
#[allow(dead_code)]
pub async fn fetch_full_act_text(
    act: &NormattivaAtto,
    at_date: &str,
    config: &Config,
    sf: &SafeFetch,
    logger: &dyn Logger,
    concurrency_limit: usize,
) -> Option<(String, String)> {
    use futures::stream::{FuturesUnordered, StreamExt};

    let main_parts = fetch_article_group(act, at_date, 0, config, sf).await;

    let mut futs = FuturesUnordered::new();
    let mut launched = 0;
    let mut next_group = 1u32;
    let mut allegati_results: Vec<Vec<String>> = Vec::new();
    let limit = concurrency_limit.max(1);

    while next_group <= MAX_ALLEGATI_GROUPS || !futs.is_empty() {
        while launched < limit && next_group <= MAX_ALLEGATI_GROUPS {
            let g = next_group;
            next_group += 1;
            launched += 1;
            futs.push(async move {
                fetch_article_group(act, at_date, g, config, sf).await
            });
        }
        match futs.next().await {
            Some(parts) => {
                launched -= 1;
                allegati_results.push(parts);
            }
            None => break,
        }
    }

    let mut all = main_parts;
    for batch in allegati_results {
        all.extend(batch);
    }

    if all.is_empty() {
        logger.log(&format!("Nessun articolo trovato per {}", act.codice_redazionale));
        return None;
    }

    let raw = all.join("\n");
    let plain = crate::api::text::html_to_plain_text(&raw);
    Some((raw, plain))
}

/// Search for a Decreto-Legge's conversion law via ricerca/avanzata.
pub async fn fetch_conversion_law(
    dl_codice: &str,
    config: &Config,
    sf: &SafeFetch,
    logger: &dyn Logger,
) -> Option<NormattivaAtto> {
    let url = format!("{}/api/v1/ricerca/avanzata", config.api_base);
    let body = json!({
        "testoRicerca": dl_codice,
        "denominazioneAtto": "LEGGE",
        "paginazione": { "paginaCorrente": 0, "numeroElementiPerPagina": 5 }
    });

    match sf.post_json::<RicercaResponse>(&url, &body).await {
        Ok(res) => {
            let re = regex::Regex::new(r"(?i)conversion[ei]").ok()?;
            res.lista_atti
                .unwrap_or_default()
                .into_iter()
                .find(|a| {
                    re.is_match(a.titolo_atto.as_deref().unwrap_or(""))
                        || re.is_match(a.descrizione_atto.as_deref().unwrap_or(""))
                })
        }
        Err(err) => {
            logger.log(&format!("fetchConversionLaw fallito per {dl_codice}: {err}"));
            None
        }
    }
}

/// Lifecycle status of an act, from `classeProvvedimento`.
/// "1" = in_force, "2" = updated, "3" = abrogated. Errors default to in_force.
pub async fn fetch_act_status(
    act: &NormattivaAtto,
    config: &Config,
    sf: &SafeFetch,
    logger: &dyn Logger,
) -> ActStatus {
    let url = format!("{}/api/v1/ricerca/avanzata", config.api_base);
    let body = json!({
        "testoRicerca": act.codice_redazionale,
        "paginazione": { "paginaCorrente": 0, "numeroElementiPerPagina": 1 }
    });
    let res: RicercaResponse = match sf.post_json(&url, &body).await {
        Ok(r) => r,
        Err(err) => {
            logger.log(&format!(
                "fetchActStatus fallito per {}: {err}",
                act.codice_redazionale
            ));
            return ActStatus::InForce;
        }
    };

    let item = res
        .lista_atti
        .unwrap_or_default()
        .into_iter()
        .find(|a| a.codice_redazionale == act.codice_redazionale);
    let classe = item
        .as_ref()
        .and_then(|i| i.classe_provvedimento.clone())
        .or_else(|| act.classe_provvedimento.clone());

    match classe.as_deref() {
        Some("3") => ActStatus::Abrogated,
        Some("2") => ActStatus::Updated,
        _ => ActStatus::InForce,
    }
}
