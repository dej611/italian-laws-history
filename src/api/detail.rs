use serde_json::{json, Value};

use crate::api::text::{
    build_act_urn, denomination_hint, denomination_to_urn_form, is_well_formed_urn, parse_urn_tail,
};
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
        if let Some(atto) = fetch_act_detail_by_urn(&urn, config, sf, logger).await {
            return Some(atto);
        }
        // URN endpoint returned empty — fall through to the legacy endpoint.
        // Many 1945–1980 acts only carry the consolidated/multivigenza text
        // and have no @originale payload via the URN endpoint.
        logger.log(&format!(
            "URN endpoint vuoto per {} (URN {urn}), fallback legacy",
            act.codice_redazionale
        ));
    } else {
        logger.log(&format!(
            "Impossibile costruire URN per {}, uso endpoint legacy",
            act.codice_redazionale
        ));
    }

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

/// Recover a canonical URN for a malformed reference by looking up the act
/// via `ricerca/avanzata` using the date and number embedded in the URN.
///
/// Returns:
///   - the canonical URN built from the matched act's metadata, or
///   - None when no unambiguous match is found.
///
/// Costs one extra API call per attempted recovery. Rate-limited via the
/// shared SafeFetch limiter.
pub async fn resolve_malformed_urn(
    malformed_urn: &str,
    config: &Config,
    sf: &SafeFetch,
    logger: &dyn Logger,
) -> Option<String> {
    let tail = parse_urn_tail(malformed_urn)?;

    let url = format!("{}/api/v1/ricerca/avanzata", config.api_base);
    // The API expects month/day as their numeric form (no zero-padding).
    let month_no_pad = tail.month.trim_start_matches('0');
    let day_no_pad = tail.day.trim_start_matches('0');
    let body = json!({
        "annoProvvedimento": tail.year,
        "meseProvvedimento": if month_no_pad.is_empty() { "0" } else { month_no_pad },
        "giornoProvvedimento": if day_no_pad.is_empty() { "0" } else { day_no_pad },
        "numeroProvvedimento": tail.num,
        "paginazione": { "paginaCorrente": 0, "numeroElementiPerPagina": 5 }
    });

    let res: RicercaResponse = match sf.post_json(&url, &body).await {
        Ok(r) => r,
        Err(err) => {
            logger.log(&format!(
                "resolveMalformedUrn fallito per {malformed_urn}: {err}"
            ));
            return None;
        }
    };

    // Strict match on (year, month, day, num) — the search index can return
    // approximate hits, so re-check before accepting.
    let candidates: Vec<NormattivaAtto> = res
        .lista_atti
        .unwrap_or_default()
        .into_iter()
        .filter(|a| {
            if a.anno_provvedimento.as_deref() != Some(tail.year.as_str()) {
                return false;
            }
            if a.numero_provvedimento.as_deref() != Some(tail.num.as_str()) {
                return false;
            }
            let mm_match = match a.mese_provvedimento.as_deref() {
                None => true,
                Some(m) => {
                    m.parse::<u32>().ok() == tail.month.parse::<u32>().ok()
                }
            };
            if !mm_match {
                return false;
            }
            let dd_match = match a.giorno_provvedimento.as_deref() {
                None => true,
                Some(d) => {
                    d.parse::<u32>().ok() == tail.day.parse::<u32>().ok()
                }
            };
            dd_match
        })
        .collect();

    let chosen = match candidates.len() {
        0 => {
            logger.log(&format!(
                "resolveMalformedUrn: nessun match per {malformed_urn}"
            ));
            return None;
        }
        1 => candidates.into_iter().next().unwrap(),
        _ => {
            // Tie-break by denomination hint (when the malformed URN carried one).
            let hint = denomination_hint(malformed_urn);
            let by_hint = hint.as_ref().and_then(|h| {
                candidates.iter().find(|a| {
                    let denom = match a.denominazione_atto.as_deref() {
                        Some(d) => d.trim().to_uppercase(),
                        None => return false,
                    };
                    if denom.is_empty() {
                        return false;
                    }
                    let urn_denom = denomination_to_urn_form(&denom);
                    urn_denom == *h
                        || urn_denom.ends_with(&format!(".{h}"))
                        || urn_denom.starts_with(&format!("{h}."))
                })
            });
            match by_hint {
                Some(a) => a.clone(),
                None => {
                    logger.log(&format!(
                        "resolveMalformedUrn: {} candidati per {malformed_urn}, ambiguo",
                        candidates.len()
                    ));
                    return None;
                }
            }
        }
    };

    let rebuilt = build_act_urn(&chosen)?;
    if !is_well_formed_urn(&rebuilt) {
        logger.log(&format!(
            "resolveMalformedUrn: ricostruzione fallita per {malformed_urn}"
        ));
        return None;
    }
    logger.log(&format!(
        "resolveMalformedUrn: {malformed_urn} → {rebuilt}"
    ));
    Some(rebuilt)
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
