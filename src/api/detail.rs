use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::api::text::{
    build_act_urn, denomination_hint, denomination_to_urn_form, is_well_formed_urn, parse_urn_tail,
};
use crate::http::SafeFetch;
use crate::logger::Logger;
use crate::types::{
    ActStatus, AttoDto, Config, ConversionSearchContext, DettaglioAttoResponse, NormattivaAtto,
    RicercaResponse,
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

static CODICE_REDAZIONALE_IN_TEXT_RE: OnceLock<Regex> = OnceLock::new();

fn codice_redazionale_in_text_re() -> &'static Regex {
    CODICE_REDAZIONALE_IN_TEXT_RE.get_or_init(|| {
        Regex::new(r"\b\d{2,6}[A-Z]\d{3,}\b").expect("CODICE_REDAZIONALE_IN_TEXT_RE")
    })
}

fn extract_codici_redazionali_from_blob(blob: &str) -> HashSet<String> {
    let re = codice_redazionale_in_text_re();
    re.find_iter(blob)
        .map(|m| m.as_str().to_string())
        .collect()
}

fn collect_ultimi_atti_modificanti_codici(res: &DettaglioAttoResponse) -> HashSet<String> {
    let mut parts: Vec<&str> = Vec::new();
    let Some(data) = res.data.as_ref() else {
        return HashSet::new();
    };
    if let Some(s) = data.ultimi_atti_modificanti.as_deref() {
        if !s.is_empty() {
            parts.push(s);
        }
    }
    if let Some(s) = data
        .atto
        .as_ref()
        .and_then(|a| a.ultimi_atti_modificanti.as_deref())
    {
        if !s.is_empty() {
            parts.push(s);
        }
    }
    extract_codici_redazionali_from_blob(&parts.join("\n"))
}

async fn fetch_dettaglio_atto_shell(
    ctx: ConversionSearchContext<'_>,
    data_vigenza: &str,
    config: &Config,
    sf: &SafeFetch,
) -> Option<DettaglioAttoResponse> {
    let url = format!("{}/api/v1/atto/dettaglio-atto", config.api_base);
    let mut body = json!({
        "codiceRedazionale": ctx.codice_redazionale,
        "dataGU": ctx.data_gu,
        "tipoDettaglio": "multivigenza",
        "dataVigenza": data_vigenza,
    });
    if let Some(ns) = ctx.numero_supplemento.and_then(|s| s.parse::<u64>().ok()) {
        if ns > 0 {
            body["numeroSupplemento"] = Value::from(ns);
        }
    }
    sf.post_json(&url, &body).await.ok()
}

fn is_legge_denomination(denom: Option<&str>) -> bool {
    let Some(d) = denom.map(|s| s.trim().to_uppercase()) else {
        return false;
    };
    d == "LEGGE" || d == "LEGGE COSTITUZIONALE"
}

fn is_rdl_ratification_context(ctx: ConversionSearchContext<'_>) -> bool {
    matches!(
        ctx.denominazione_atto.map(|s| s.trim().to_uppercase()).as_deref(),
        Some(d) if d == "REGIO DECRETO-LEGGE"
    )
}

fn strip_leading_zeros(s: &str) -> &str {
    let t = s.trim_start_matches('0');
    if t.is_empty() {
        s
    } else {
        t
    }
}

fn score_conversion_candidate(
    hit: &NormattivaAtto,
    ctx: ConversionSearchContext<'_>,
    linked_codici: &HashSet<String>,
) -> i32 {
    if hit.codice_redazionale == ctx.codice_redazionale {
        return 0;
    }
    if !is_legge_denomination(hit.denominazione_atto.as_deref()) {
        return 0;
    }

    let tit = format!(
        "{}\n{}",
        hit.titolo_atto.as_deref().unwrap_or(""),
        hit.descrizione_atto.as_deref().unwrap_or("")
    );
    let rdl = is_rdl_ratification_context(ctx);
    let mut score: i32 = 0;

    if linked_codici.contains(&hit.codice_redazionale) {
        score += 220;
    }

    let codice_esc = regex::escape(ctx.codice_redazionale);
    if let Ok(re) = Regex::new(&format!(r"(?i){codice_esc}")) {
        if re.is_match(&tit) {
            score += 80;
        }
    }

    if let (Some(anno), Some(num)) = (ctx.anno_provvedimento, ctx.numero_provvedimento) {
        let yr = strip_leading_zeros(anno);
        let n = strip_leading_zeros(num);
        let yr_e = regex::escape(yr);
        let n_e = regex::escape(n);
        let dl_pat = format!(
            r"(?i)(?:decreto[-\s]?legge|d\.\s*l\.\s*|d\.l\.)[^\d]{{0,40}}{yr_e}[^\d]{{0,12}}{n_e}\b"
        );
        let rdl_pat = format!(
            r"(?i)(?:regio\s+decreto[-\s]?legge|rdl|r\.d\.l\.)[^\d]{{0,40}}{yr_e}[^\d]{{0,12}}{n_e}\b"
        );
        if Regex::new(&dl_pat).map(|r| r.is_match(&tit)).unwrap_or(false) {
            score += 70;
        }
        if rdl && Regex::new(&rdl_pat).map(|r| r.is_match(&tit)).unwrap_or(false) {
            score += 70;
        }
    }

    if Regex::new(r"(?i)\bconvertito\s+in\s+legge\b")
        .map(|r| r.is_match(&tit))
        .unwrap_or(false)
    {
        score += 110;
    }
    if Regex::new(r"(?i)\blegge\s+di\s+conversione\b")
        .map(|r| r.is_match(&tit))
        .unwrap_or(false)
    {
        score += 110;
    }
    if Regex::new(r"(?i)\bconversione\s+in\s+legge\b")
        .map(|r| r.is_match(&tit))
        .unwrap_or(false)
    {
        score += 95;
    }
    if Regex::new(r"(?i)\bconverte(?:\s+il|\s+la)?\b")
        .map(|r| r.is_match(&tit))
        .unwrap_or(false)
    {
        score += 45;
    }
    if Regex::new(r"(?i)\bconvertit[aei]\b")
        .map(|r| r.is_match(&tit))
        .unwrap_or(false)
    {
        score += 40;
    }
    if Regex::new(r"(?i)\bconversione\b")
        .map(|r| r.is_match(&tit))
        .unwrap_or(false)
    {
        score += 38;
    }
    if Regex::new(r"(?i)conversion[ei]")
        .map(|r| r.is_match(&tit))
        .unwrap_or(false)
    {
        score += 35;
    }

    if rdl {
        if Regex::new(r"(?i)\bratificazion[ei]\b")
            .map(|r| r.is_match(&tit))
            .unwrap_or(false)
        {
            score += 95;
        }
        if Regex::new(r"(?i)\bratific[ao]\b")
            .map(|r| r.is_match(&tit))
            .unwrap_or(false)
        {
            score += 85;
        }
        if Regex::new(r"(?i)\bratificat[aei]\b")
            .map(|r| r.is_match(&tit))
            .unwrap_or(false)
        {
            score += 80;
        }
        if Regex::new(r"(?i)\bapprovazione\b")
            .map(|r| r.is_match(&tit))
            .unwrap_or(false)
            && Regex::new(r"(?i)regio\s+decreto[-\s]?legge")
                .map(|r| r.is_match(&tit))
                .unwrap_or(false)
        {
            score += 55;
        }
    }

    score
}

const CONVERSION_SEARCH_PAGE_SIZE: u32 = 25;
const CONVERSION_SEARCH_MAX_PAGES: u32 = 12;
const CONVERSION_SCORE_THRESHOLD: i32 = 72;

async fn ricerca_leggi_mentioning_dl(
    ctx: ConversionSearchContext<'_>,
    config: &Config,
    sf: &SafeFetch,
    use_pub_date_lower_bound: bool,
) -> Vec<NormattivaAtto> {
    let url = format!("{}/api/v1/ricerca/avanzata", config.api_base);
    let mut collected: Vec<NormattivaAtto> = Vec::new();
    let mut total_pages: u32 = 1;
    let mut page: u32 = 0;

    while page < CONVERSION_SEARCH_MAX_PAGES && page < total_pages {
        let mut base = serde_json::Map::new();
        base.insert(
            "testoRicerca".to_string(),
            Value::String(ctx.codice_redazionale.to_string()),
        );
        base.insert(
            "denominazioneAtto".to_string(),
            Value::String("LEGGE".into()),
        );
        base.insert(
            "paginazione".to_string(),
            json!({
                "paginaCorrente": page,
                "numeroElementiPerPagina": CONVERSION_SEARCH_PAGE_SIZE,
            }),
        );
        if use_pub_date_lower_bound && !ctx.data_gu.is_empty() {
            let iso = format!("{}T00:00:00.000Z", ctx.data_gu);
            base.insert(
                "dataInizioPubProvvedimento".to_string(),
                Value::String(iso),
            );
        }
        let body = Value::Object(base);

        let res: RicercaResponse = match sf.post_json(&url, &body).await {
            Ok(r) => r,
            Err(_) => break,
        };
        total_pages = res.numero_pagine.unwrap_or(1);
        let page_acts = res.lista_atti.unwrap_or_default();
        if page_acts.is_empty() {
            break;
        }
        collected.extend(page_acts);
        page += 1;
    }

    collected
}

fn try_pick_best_conversion(
    hits: &[NormattivaAtto],
    ctx: ConversionSearchContext<'_>,
    linked_codici: &HashSet<String>,
) -> Option<NormattivaAtto> {
    let mut best: Option<(i32, NormattivaAtto)> = None;
    for hit in hits {
        let s = score_conversion_candidate(hit, ctx, linked_codici);
        if let Some((bs, _)) = best.as_ref() {
            if s <= *bs {
                continue;
            }
        }
        best = Some((s, hit.clone()));
    }
    let (best_score, best_hit) = best?;
    if linked_codici.contains(&best_hit.codice_redazionale) {
        return Some(best_hit);
    }
    if best_score >= CONVERSION_SCORE_THRESHOLD {
        return Some(best_hit);
    }
    None
}

/// Search for the ordinary law that converts a decreto-legge, or ratifies a
/// regio decreto-legge, using `dettaglio-atto` modifier links when present,
/// paginated `ricerca/avanzata`, and scored title heuristics (TS parity).
pub async fn fetch_conversion_law(
    ctx: ConversionSearchContext<'_>,
    config: &Config,
    sf: &SafeFetch,
    _logger: &dyn Logger,
) -> Option<NormattivaAtto> {
    let codice = ctx.codice_redazionale;
    let mut linked_codici: HashSet<String> = HashSet::new();

    let detail = fetch_dettaglio_atto_shell(ctx, ctx.data_gu, config, sf).await;
    if let Some(ref d) = detail {
        if d.success.unwrap_or(false) {
            for c in collect_ultimi_atti_modificanti_codici(d) {
                if c != codice {
                    linked_codici.insert(c);
                }
            }
        }
    }

    let hits_a = ricerca_leggi_mentioning_dl(ctx, config, sf, true).await;
    if let Some(hit) = try_pick_best_conversion(&hits_a, ctx, &linked_codici) {
        return Some(hit);
    }
    let hits_b = ricerca_leggi_mentioning_dl(ctx, config, sf, false).await;
    if let Some(hit) = try_pick_best_conversion(&hits_b, ctx, &linked_codici) {
        return Some(hit);
    }

    let linked_snapshot: Vec<String> = linked_codici.iter().cloned().collect();
    for link_cod in &linked_snapshot {
        let url = format!("{}/api/v1/ricerca/avanzata", config.api_base);
        let body = json!({
            "testoRicerca": link_cod,
            "denominazioneAtto": "LEGGE",
            "paginazione": { "paginaCorrente": 0, "numeroElementiPerPagina": 15 }
        });
        let res: RicercaResponse = match sf.post_json(&url, &body).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        let list = res.lista_atti.unwrap_or_default();
        let exact = list.into_iter().find(|a| {
            a.codice_redazionale == *link_cod
                && is_legge_denomination(a.denominazione_atto.as_deref())
        });
        if let Some(ex) = exact {
            if score_conversion_candidate(&ex, ctx, &linked_codici) >= 40 {
                return Some(ex);
            }
        }
    }

    None
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
