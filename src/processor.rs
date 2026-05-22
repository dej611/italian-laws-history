use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Result;
use chrono::{NaiveDate, Utc};
use serde_json::Value;
use tokio::fs;
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;

use crate::api::detail::{
    fetch_act_detail, fetch_act_detail_by_urn, fetch_act_status, fetch_conversion_law,
    resolve_malformed_urn,
};
use crate::api::search::fetch_updated_acts;
use crate::api::text::{
    atto_file_name, build_file_name, extract_urns, html_to_plain_text, is_well_formed_urn,
    resolve_branchable_type, to_plain_text, urn_date,
};
use crate::checkpoint::save_checkpoint_atomic;
use crate::git::{branch_name_for, GitHelpers};
use crate::http::SafeFetch;
use crate::logger::{is_shutdown_requested, Logger};
use crate::types::{
    ActStatus, ActVersionEntry, AttoDto, BranchableShort, Checkpoint, Config, ConversionSearchContext,
    NormattivaAtto, PendingAct,
};

const SECS_PER_DAY: i64 = 24 * 60 * 60;
const ETA_MONTH_WINDOW: usize = 6;
const RATE_WINDOW_MS: u128 = 5 * 60 * 1000; // 5 minutes

#[derive(Clone)]
pub struct ProcessorDeps {
    pub config: Arc<Config>,
    pub logger: Arc<dyn Logger>,
    pub safe_fetch: Arc<SafeFetch>,
    pub git: Arc<GitHelpers>,
    pub shutdown: watch::Receiver<bool>,
}

#[derive(Debug, Clone, Copy)]
pub struct EtaContext {
    pub current_window_date: Option<NaiveDate>,
    pub remaining_months: u32,
}

fn enriched_entry(act: &NormattivaAtto, date: String, refs: u32) -> ActVersionEntry {
    ActVersionEntry {
        date,
        year: act
            .anno_provvedimento
            .clone()
            .or_else(|| act.data_gu.get(0..4).map(|s| s.to_string())),
        kind: act.denominazione_atto.clone(),
        refs: Some(refs),
    }
}

fn has_lapsed(act: &PendingAct, status: ActStatus) -> bool {
    if status == ActStatus::Abrogated {
        return true;
    }
    // Acts without an automatic decadenza (pre-1926 RDL, 1944–46 DLL/DLCPS
    // waiting for the L. 561/1956 sanatoria) only lapse on explicit
    // abrogation, never by deadline alone.
    let Some(deadline_days) = act.deadline_days else { return false };
    let Some(parsed) = parse_iso_or_date(&act.data_gu) else { return false };
    let now = Utc::now().timestamp();
    now - parsed > i64::from(deadline_days) * SECS_PER_DAY
}

/// Migrate a legacy `pendingDecretiLegge` checkpoint field into the
/// generalised `pendingActs` field. Idempotent: safe to call repeatedly.
///
/// Old entries lacked `short` and `deadlineDays`. Serde's defaults already
/// fill those in as `Dl` + `Some(60)` on deserialisation, so this fn only
/// has to merge the two maps and clear the legacy field.
fn ensure_pending_acts_migrated(checkpoint: &mut Checkpoint) -> &mut HashMap<String, PendingAct> {
    let mut pending = checkpoint.pending_acts.take().unwrap_or_default();
    if let Some(legacy) = checkpoint.pending_decreti_legge.take() {
        for (codice, entry) in legacy {
            pending.entry(codice).or_insert(entry);
        }
    }
    checkpoint.pending_acts = Some(pending);
    checkpoint.pending_acts.as_mut().unwrap()
}

fn parse_iso_or_date(s: &str) -> Option<i64> {
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(d.timestamp());
    }
    let trimmed = s.get(0..10).unwrap_or(s);
    let date = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp())
}

/// Convert a `dataGU` (ISO datetime or `YYYY-MM-DD`) to a bare `YYYY-MM-DD`.
fn iso_to_date(s: &str) -> String {
    s.get(0..10).unwrap_or(s).to_string()
}

fn vigenza_after(iso: &str) -> String {
    parse_iso_or_date(iso)
        .and_then(|ts| chrono::DateTime::<Utc>::from_timestamp(ts + 24 * 60 * 60, 0))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| iso_to_date(iso))
}

/// Git merge date for a lapsed DL: constitutional lapse is emanation + deadline when
/// known, so `git log` timelines match reality (not the scrape run day).
fn merge_decaduto_date(data_gu: &str, deadline_days: Option<u32>, today: &str) -> String {
    let Some(deadline_days) = deadline_days else {
        return today.to_string();
    };
    let gu_date = iso_to_date(data_gu);
    let Ok(from) = NaiveDate::parse_from_str(&gu_date, "%Y-%m-%d") else {
        return today.to_string();
    };
    let lapse = from + chrono::Duration::days(i64::from(deadline_days));
    let lapse_str = lapse.format("%Y-%m-%d").to_string();
    if lapse_str.as_str() <= today {
        lapse_str
    } else {
        today.to_string()
    }
}

// ---- ETA / rate tracking ----------------------------------------------------

static MONTH_TRACKER: std::sync::LazyLock<Mutex<MonthTracker>> =
    std::sync::LazyLock::new(|| Mutex::new(MonthTracker::default()));

#[derive(Default)]
struct MonthTracker {
    monthly_act_counts: VecDeque<u32>,
    completion_timestamps: VecDeque<Instant>,
}

pub fn record_month_completed(count: u32) {
    let mut t = MONTH_TRACKER.lock().unwrap();
    t.monthly_act_counts.push_back(count);
    while t.monthly_act_counts.len() > ETA_MONTH_WINDOW {
        t.monthly_act_counts.pop_front();
    }
}

fn record_completion() {
    let mut t = MONTH_TRACKER.lock().unwrap();
    let now = Instant::now();
    t.completion_timestamps.push_back(now);
    while let Some(front) = t.completion_timestamps.front().copied() {
        if now.duration_since(front).as_millis() > RATE_WINDOW_MS {
            t.completion_timestamps.pop_front();
        } else {
            break;
        }
    }
}

fn current_rate_per_minute() -> Option<f64> {
    let t = MONTH_TRACKER.lock().unwrap();
    if t.completion_timestamps.len() < 2 {
        return None;
    }
    let oldest = *t.completion_timestamps.front()?;
    let elapsed_min = Instant::now().duration_since(oldest).as_secs_f64() / 60.0;
    if elapsed_min == 0.0 {
        return None;
    }
    Some(t.completion_timestamps.len() as f64 / elapsed_min)
}

fn format_eta(total_minutes: f64) -> String {
    if total_minutes < 1.0 {
        return "~<1m".to_string();
    }
    let days = (total_minutes / 1440.0).floor() as i64;
    let hours = ((total_minutes % 1440.0) / 60.0).floor() as i64;
    let mins = (total_minutes % 60.0).round() as i64;
    if days > 30 {
        return ">30g".to_string();
    }
    if days > 0 {
        return format!("~{days}g {hours}h");
    }
    if hours > 0 {
        return format!("~{hours}h {mins}m");
    }
    format!("~{mins}m")
}

struct EtaResult {
    eta: String,
    estimated_total: u64,
}

fn compute_eta(remaining_months: u32, processed: usize) -> Option<EtaResult> {
    let t = MONTH_TRACKER.lock().unwrap();
    if t.monthly_act_counts.is_empty() || remaining_months == 0 {
        return None;
    }
    drop(t);

    let rate = current_rate_per_minute()?;
    if rate <= 0.0 {
        return None;
    }
    let t = MONTH_TRACKER.lock().unwrap();
    let avg = t.monthly_act_counts.iter().copied().sum::<u32>() as f64
        / t.monthly_act_counts.len() as f64;
    drop(t);
    let estimated_remaining = avg * remaining_months as f64;
    let eta_minutes = estimated_remaining / rate;
    Some(EtaResult {
        eta: format_eta(eta_minutes),
        estimated_total: (processed as f64 + estimated_remaining).round() as u64,
    })
}

/// Update the Stato line — mirrors TS `logger.setStatus` in Phase 2.
pub(crate) fn update_progress_status(
    logger: &dyn Logger,
    checkpoint: &Checkpoint,
    eta_ctx: Option<&EtaContext>,
    phase: Option<&str>,
) {
    let processed = checkpoint.act_versions.len();
    let remaining_days = eta_ctx
        .and_then(|c| c.current_window_date)
        .map(|d| (Utc::now().date_naive() - d).num_days());
    let remaining_str = remaining_days
        .map(|n| format!(" — {n} giorni rimasti"))
        .unwrap_or_default();
    let rate = current_rate_per_minute();
    let rate_str = rate
        .map(|r| format!(" — {r:.1} atti/min"))
        .unwrap_or_default();
    let eta = eta_ctx.and_then(|c| compute_eta(c.remaining_months, processed));
    let (count_str, eta_str) = match eta {
        Some(e) => (
            format!("{processed} / ~{}", e.estimated_total),
            format!(" — ETA {}", e.eta),
        ),
        None => (format!("{processed}"), String::new()),
    };
    let phase_str = phase.map(|p| format!(" — {p}")).unwrap_or_default();
    logger.set_status(&format!(
        "Elaborati {count_str}{remaining_str}{rate_str}{eta_str}{phase_str}"
    ));
}

// ---- Relationship files -----------------------------------------------------

/// Write URN reference files and `.modifiedby` sidecars on the currently
/// checked-out branch. URN fetches are parallelised under a semaphore;
/// file writes are serial. Returns the list of files to bundle into the
/// caller's commit.
#[allow(clippy::too_many_arguments)]
async fn write_relationship_files(
    act_id: &str,
    act: &NormattivaAtto,
    raw: &str,
    safe_file_name: &str,
    before_date: &str,
    updated_urns: &mut HashSet<String>,
    deps: &ProcessorDeps,
    sem: Arc<Semaphore>,
) -> Vec<String> {
    let _span = tracing::info_span!("process", op = "writeRelationshipFiles", act_id).entered();
    let logger = deps.logger.as_ref();
    let mut written: Vec<String> = Vec::new();

    let refs: Vec<String> = extract_urns(raw, Some(act_id), Some(before_date))
        .into_iter()
        .filter(|u| !updated_urns.contains(u))
        .collect();

    if !refs.is_empty() {
        logger.log(&format!(
            "{act_id} referenzia {} atti — aggiornamento...",
            refs.len()
        ));
    }
    for u in &refs {
        updated_urns.insert(u.clone());
    }

    let mut set: JoinSet<(String, Option<AttoDto>)> = JoinSet::new();
    for urn in refs.iter().cloned() {
        let sem = sem.clone();
        let config = deps.config.clone();
        let sf = deps.safe_fetch.clone();
        let logger = deps.logger.clone();
        let before_date = before_date.to_string();
        set.spawn(async move {
            let permit = sem.acquire_owned().await.expect("semaphore");
            // Recover malformed URNs (e.g. urn:nir:::1895-02-21;70) by looking
            // up the act via ricerca/avanzata and rebuilding the canonical URN.
            // Costs +1 API call per malformed reference, but salvages documents
            // we'd otherwise drop.
            let canonical = if is_well_formed_urn(&urn) {
                urn.clone()
            } else {
                match resolve_malformed_urn(&urn, &config, &sf, logger.as_ref()).await {
                    Some(c) => c,
                    None => {
                        drop(permit);
                        return (urn, None);
                    }
                }
            };
            // !vig= before the act's own vigenza returns "NON ANCORA ESISTENTE"
            // or 404. Use @originale when before_date predates the cited act.
            let ref_date = urn_date(&canonical);
            let versioned = match ref_date.as_deref() {
                Some(d) if d > before_date.as_str() => format!("{canonical}@originale"),
                _ => format!("{canonical}!vig={before_date}"),
            };
            let atto = fetch_act_detail_by_urn(&versioned, &config, &sf, logger.as_ref()).await;
            drop(permit);
            (urn, atto)
        });
    }

    while let Some(joined) = set.join_next().await {
        let Ok((urn, ref_atto_opt)) = joined else { continue };
        let Some(ref_atto) = ref_atto_opt else { continue };
        let Some(html) = ref_atto.testo_in_vigore.clone().or(ref_atto.articolo_html.clone())
        else { continue };
        if html.is_empty() { continue; }
        let plain = html_to_plain_text(&html);
        if plain.is_empty() { continue; }
        let ref_file_name = atto_file_name(&ref_atto, &urn);
        let ref_file_path: PathBuf = PathBuf::from(&deps.config.output_repo).join(&ref_file_name);
        if let Err(err) = fs::write(&ref_file_path, &plain).await {
            logger.log(&format!("Errore scrittura {ref_file_name}: {err}"));
            continue;
        }
        written.push(ref_file_name.clone());
        logger.log(&format!("Wrote ref {ref_file_name}"));
    }

    // Sequential: explicit modifier sidecars (typically 0–1 entries).
    if let Some(modifiers_str) = act.ultimi_atti_modificanti.as_deref() {
        let modifiers: Vec<&str> = modifiers_str.split_whitespace().filter(|s| !s.is_empty()).collect();
        for mod_codice in modifiers {
            let rel_file_name = format!("{safe_file_name}.modifiedby");
            let rel_path: PathBuf = PathBuf::from(&deps.config.output_repo).join(&rel_file_name);
            if let Err(err) = fs::write(&rel_path, mod_codice).await {
                logger.log(&format!("Errore scrittura {rel_file_name}: {err}"));
                continue;
            }
            written.push(rel_file_name.clone());
            logger.log(&format!("Wrote relazione {act_id} ← {mod_codice}"));
        }
    }

    written
}

// ---- Bulk ratification (sanatoria) ------------------------------------------

/// A bulk-ratification law: a single ordinary LEGGE that converts/ratifies an
/// entire cohort of provisional decrees in one stroke.
///
/// Identified by `(anno_provvedimento, numero_provvedimento)` — that pair is
/// canonical even when the `codice_redazionale` differs across reprints.
///
/// Each entry says: "this law ratifies acts whose `short` is in
/// `covers_shorts` AND whose `data_gu` falls in
/// [`from_date`, `to_date`] (inclusive)".
struct SanatoriaLaw {
    /// Year of the ratifying law.
    anno: &'static str,
    /// Number of the ratifying law within that year.
    numero: &'static str,
    /// Human label used in the merge subject.
    label: &'static str,
    /// Branch namespaces this law ratifies.
    covers_shorts: &'static [BranchableShort],
    /// Inclusive ISO-date lower bound of the act's data_gu window.
    from_date: &'static str,
    /// Inclusive ISO-date upper bound of the act's data_gu window.
    to_date: &'static str,
}

const SANATORIA_LAWS: &[SanatoriaLaw] = &[
    // L. 17 aprile 1925 n. 473 ("articolo unico"): ratified ~237 luogotenenziali
    // and decreti-legge emanated through 23 maggio 1924.
    SanatoriaLaw {
        anno: "1925",
        numero: "473",
        label: "L. 473/1925",
        covers_shorts: &[BranchableShort::Dll, BranchableShort::Rdl],
        from_date: "0001-01-01",
        to_date: "1924-05-23",
    },
    // L. 17 aprile 1956 n. 561: ratified the 1944–47 transition cohort
    // (DLL, DLCPS) emanated when no Parliament was sitting.
    SanatoriaLaw {
        anno: "1956",
        numero: "561",
        label: "L. 561/1956",
        covers_shorts: &[BranchableShort::Dll, BranchableShort::Dlcps],
        from_date: "1944-06-25",
        to_date: "1947-12-31",
    },
];

/// Match an act against the table of known sanatoria laws by year + number.
fn find_sanatoria_law(act: &NormattivaAtto) -> Option<&'static SanatoriaLaw> {
    let denom = act.denominazione_atto.as_deref()?.trim().to_uppercase();
    if denom != "LEGGE" {
        return None;
    }
    let anno = act.anno_provvedimento.as_deref()?;
    let numero = act.numero_provvedimento.as_deref()?;
    SANATORIA_LAWS
        .iter()
        .find(|s| s.anno == anno && s.numero == numero)
}

/// Date-range comparison on the leading 10-byte `YYYY-MM-DD` prefix.
fn date_in_range(date: &str, from: &str, to: &str) -> bool {
    let p = date.get(..10).unwrap_or(date);
    p >= from && p <= to
}

/// Apply a bulk-ratification law (e.g. L. 473/1925, L. 561/1956): octopus-merge
/// every still-open branch in scope into `history-rs` with one merge commit,
/// then remove those entries from `pending_acts`. No-op when no branches qualify.
///
/// Must be called AFTER the sanatoria law's own publication commit has been
/// written on `history-rs` (so the merge sits chronologically above it). The
/// merge commit is dated to the sanatoria's publication date.
async fn apply_sanatoria(
    sanatoria: &SanatoriaLaw,
    publication_date: &str,
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
) -> Result<usize> {
    let pending = ensure_pending_acts_migrated(checkpoint);

    // Collect codici in scope first (immutable snapshot), then mutate.
    let in_scope: Vec<(String, String, BranchableShort)> = pending
        .iter()
        .filter(|(_, a)| {
            sanatoria.covers_shorts.contains(&a.short)
                && date_in_range(&a.data_gu, sanatoria.from_date, sanatoria.to_date)
        })
        .map(|(codice, a)| (codice.clone(), a.branch_name.clone(), a.short))
        .collect();

    if in_scope.is_empty() {
        deps.logger.log(&format!(
            "Sanatoria {}: nessun ramo aperto in ambito",
            sanatoria.label
        ));
        return Ok(0);
    }

    // Per-namespace counts for the merge subject's breakdown.
    let mut counts: HashMap<BranchableShort, usize> = HashMap::new();
    for (_, _, short) in &in_scope {
        *counts.entry(*short).or_insert(0) += 1;
    }
    let breakdown: Vec<String> = sanatoria
        .covers_shorts
        .iter()
        .map(|s| format!("{}={}", s.as_str(), counts.get(s).copied().unwrap_or(0)))
        .collect();
    let subject = format!(
        "SANATORIA {}: ratifica {} atti ({})",
        sanatoria.label,
        in_scope.len(),
        breakdown.join(", "),
    );
    let body: Vec<&str> = in_scope.iter().map(|(c, _, _)| c.as_str()).collect();
    let full_message = if body.is_empty() {
        subject
    } else {
        format!("{subject}\n\n{}", body.join("\n"))
    };

    let branches: Vec<String> = in_scope.iter().map(|(_, b, _)| b.clone()).collect();

    deps.logger.log(&format!(
        "Sanatoria {}: octopus-merge {} rami ({})",
        sanatoria.label,
        in_scope.len(),
        breakdown.join(", "),
    ));
    deps.git
        .octopus_merge(&branches, &full_message, publication_date)
        .await?;

    // Remove the merged entries; best-effort delete the local branches.
    for (codice, branch_name, _) in &in_scope {
        if let Err(err) = deps.git.delete_dl_branch(branch_name).await {
            deps.logger.log(&format!(
                "Sanatoria {}: errore eliminazione ramo {branch_name}: {err}",
                sanatoria.label
            ));
        }
        pending.remove(codice);
        deps.logger.log(&format!(
            "Sanatoria {}: ramo {branch_name} chiuso",
            sanatoria.label,
        ));
    }
    Ok(in_scope.len())
}

// ---- Provisional-act reconciliation -----------------------------------------

/// Marker filename for a lapsed provisional act.
///
/// Modern DL: keep the flat `<codice>.decaduto` for parity with the legacy
/// markers that already exist in the corpus. New types use a typed form
/// `<codice>.<short>.decaduto` so they're trivially distinguishable.
fn marker_file_name(codice: &str, short: BranchableShort) -> String {
    match short {
        BranchableShort::Dl => format!("{codice}.decaduto"),
        _ => format!("{codice}.{}.decaduto", short.as_str()),
    }
}

enum ReconcileOutcome {
    /// Act resolved (converted or decaduto+merged) — drop from `pending_acts`.
    Done,
    /// Act still awaiting conversion — keep in `pending_acts` for next run.
    StillWaiting,
}

/// Check each pending provisional act (DL, RDL, DLL, DLCPS) for conversion,
/// ratification, or decadenza. Merges resolved branches into `history-rs`
/// with the correct historical date. Acts with `deadline_days = None`
/// (pre-1926 RDL, 1944–46 cohort awaiting L. 561/1956) wait indefinitely
/// until either a ratifying law surfaces or Normattiva flags them as
/// abrogated.
pub async fn reconcile_pending_acts(
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
    updated_urns: &mut HashSet<String>,
    sem: Arc<Semaphore>,
    eta_ctx: Option<&EtaContext>,
) -> Result<()> {
    let _span = tracing::info_span!("process", op = "reconcileActs").entered();

    // Snapshot current pool, swap out so we can re-insert "still pending" entries.
    let pending = {
        let pool = ensure_pending_acts_migrated(checkpoint);
        std::mem::take(pool)
    };
    let mut still_pending: HashMap<String, PendingAct> = HashMap::new();
    let total = pending.len();
    if total == 0 {
        update_progress_status(
            deps.logger.as_ref(),
            checkpoint,
            eta_ctx,
            Some("riconciliazione 0/0…"),
        );
    }
    let mut index = 0usize;

    for (codice, act) in pending {
        index += 1;
        update_progress_status(
            deps.logger.as_ref(),
            checkpoint,
            eta_ctx,
            Some(&format!("riconciliazione {index}/{total}…")),
        );
        let tag = act.short.upper();
        deps.logger.log(&format!("Riconciliazione {tag} {codice}…"));

        // Guard against zombie checkpoint entries: the dl/* branch may have
        // been merged & deleted in a prior run that crashed before the
        // checkpoint was saved. In that case the work is already in the
        // history branch — drop the entry instead of failing on `git checkout`
        // of a missing branch.
        match deps.git.dl_branch_exists(&act.branch_name).await {
            Ok(false) => {
                deps.logger.log(&format!(
                    "{tag} {codice} branch {} mancante — già riconciliato, rimuovo dal checkpoint.",
                    act.branch_name
                ));
                continue;
            }
            Err(err) => {
                deps.logger.log(&format!(
                    "{tag} {codice} controllo branch fallito: {err}; lo rimando al prossimo run."
                ));
                still_pending.insert(codice, act);
                continue;
            }
            Ok(true) => {}
        }

        // Per-act error containment: one bad pending entry must not abort the
        // whole window. On error, keep the entry in `pending_acts` so a future
        // run can retry, then land back on `history` for the next iteration.
        let outcome: Result<ReconcileOutcome> = async {
            let conv = fetch_conversion_law(
                ConversionSearchContext::from_pending(&act),
                &deps.config,
                &deps.safe_fetch,
                deps.logger.as_ref(),
            )
            .await;

        if let Some(conversion) = conv {
            let merge_date = conversion
                .data_emanazione
                .as_deref()
                .and_then(|s| s.split('T').next())
                .map(str::to_string)
                .unwrap_or_else(|| iso_to_date(&conversion.data_gu));
            let merge_msg = format!(
                "Convertito in legge: {}",
                conversion
                    .descrizione_atto
                    .clone()
                    .or_else(|| conversion.titolo_atto.clone())
                    .unwrap_or_else(|| codice.clone())
            );

            deps.logger.log(&format!(
                "{tag} {codice} convertito — merge in history ({merge_date})"
            ));
            deps.git
                .merge_dl_branch(&act.branch_name, &merge_msg, &merge_date)
                .await?;

            let safe_file_name = build_file_name(
                act.denominazione_atto.as_deref(),
                act.numero_provvedimento.as_deref(),
                None,
                None,
                act.anno_provvedimento.as_deref(),
                &codice,
            );

            let act_stub = NormattivaAtto {
                codice_redazionale: act.codice_redazionale.clone(),
                data_gu: act.data_gu.clone(),
                denominazione_atto: act.denominazione_atto.clone(),
                numero_provvedimento: act.numero_provvedimento.clone(),
                anno_provvedimento: act.anno_provvedimento.clone(),
                ..Default::default()
            };

            if let Some(full_atto) = fetch_act_detail(
                &act_stub,
                &act.data_gu,
                &deps.config,
                &deps.safe_fetch,
                deps.logger.as_ref(),
                "@originale",
            )
            .await
            {
                let (raw, _plain) = to_plain_text(&full_atto);
                let ref_files = write_relationship_files(
                    &codice,
                    &act_stub,
                    &raw,
                    &safe_file_name,
                    &iso_to_date(&act.data_gu),
                    updated_urns,
                    deps,
                    sem.clone(),
                )
                .await;
                if !ref_files.is_empty() {
                    let refs: Vec<&str> = ref_files.iter().map(String::as_str).collect();
                    deps.git
                        .commit_local_multi(
                            &refs,
                            &format!("Riferimenti {tag} {codice}"),
                            &merge_date,
                        )
                        .await?;
                    deps.logger.log(&format!(
                        "Committed {} refs for {tag} {codice}",
                        ref_files.len()
                    ));
                }
            }

            deps.git.delete_dl_branch(&act.branch_name).await?;
            Ok(ReconcileOutcome::Done)
        } else {
            let status = fetch_act_status(
                &NormattivaAtto {
                    codice_redazionale: codice.clone(),
                    data_gu: act.data_gu.clone(),
                    ..Default::default()
                },
                &deps.config,
                &deps.safe_fetch,
                deps.logger.as_ref(),
            )
            .await;

            if has_lapsed(&act, status) {
                let today = Utc::now().format("%Y-%m-%d").to_string();
                let decaduto_merge_date =
                    merge_decaduto_date(&act.data_gu, act.deadline_days, &today);
                let full_denom = act
                    .denominazione_atto
                    .as_deref()
                    .map(str::to_string)
                    .unwrap_or_else(|| act.short.pretty().to_uppercase());
                let merge_msg = format!(
                    "DECADUTO: {full_denom} {} n. {}",
                    act.anno_provvedimento.as_deref().unwrap_or(""),
                    act.numero_provvedimento.as_deref().unwrap_or(&codice),
                );
                deps.logger.log(&format!(
                    "{tag} {codice} decaduto — merge DECADUTO in history"
                ));

                deps.git.checkout_branch(&act.branch_name).await?;
                let marker_name = marker_file_name(&codice, act.short);
                let marker_path: PathBuf =
                    PathBuf::from(&deps.config.output_repo).join(&marker_name);
                fs::write(
                    &marker_path,
                    format!(
                        "{} {codice} decaduto per mancata conversione.\n",
                        act.short.pretty()
                    ),
                )
                .await?;
                deps.git
                    .commit_local(
                        &marker_name,
                        &format!("Marcatore: {tag} {codice} non convertito"),
                        &decaduto_merge_date,
                    )
                    .await?;

                deps.git
                    .merge_dl_branch(&act.branch_name, &merge_msg, &decaduto_merge_date)
                    .await?;
                deps.git.delete_dl_branch(&act.branch_name).await?;
                Ok(ReconcileOutcome::Done)
            } else {
                deps.logger
                    .log(&format!("{tag} {codice} ancora in attesa di conversione."));
                Ok(ReconcileOutcome::StillWaiting)
            }
        }
        }
        .await;

        match outcome {
            Ok(ReconcileOutcome::Done) => {}
            Ok(ReconcileOutcome::StillWaiting) => {
                still_pending.insert(codice, act);
            }
            Err(err) => {
                deps.logger.log(&format!(
                    "Riconciliazione {tag} {codice} fallita: {err}"
                ));
                still_pending.insert(codice, act);
                // Clear any half-merged state before falling back to history,
                // otherwise the next iteration's checkout will fail and the
                // run will cascade-fail with "needs merge" / "unmerged files".
                if let Err(e) = deps.git.abort_merge_if_any().await {
                    deps.logger.log(&format!(
                        "merge --abort dopo errore fallito: {e}"
                    ));
                }
                if let Err(e) = deps.git.checkout().await {
                    deps.logger.log(&format!(
                        "Checkout history dopo errore fallito: {e}"
                    ));
                }
            }
        }
    }

    checkpoint.pending_acts = if still_pending.is_empty() {
        None
    } else {
        Some(still_pending)
    };
    Ok(())
}

/// Back-compat alias for callers still using the DL-only name.
#[deprecated(note = "use `reconcile_pending_acts`")]
#[allow(dead_code)]
pub async fn reconcile_pending_decreti_legge(
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
    updated_urns: &mut HashSet<String>,
    sem: Arc<Semaphore>,
) -> Result<()> {
    reconcile_pending_acts(checkpoint, deps, updated_urns, sem, None).await
}

// ---- Phase A: process_batches -----------------------------------------------

pub async fn process_batches(
    acts: &[NormattivaAtto],
    checkpoint: &mut Checkpoint,
    force: bool,
    deps: &ProcessorDeps,
    eta_ctx: Option<&EtaContext>,
) -> Result<()> {
    let _span = tracing::info_span!("process", op = "processBatches", count = acts.len()).entered();
    if is_shutdown_requested(&deps.shutdown) {
        return Ok(());
    }
    let mut updated_urns: HashSet<String> = HashSet::new();
    let sem = Arc::new(Semaphore::new(num_cpus::get().max(1)));

    deps.git.checkout().await?;
    deps.git.pull().await?;

    deps.logger.update_list(acts);

    reconcile_pending_acts(checkpoint, deps, &mut updated_urns, sem.clone(), eta_ctx).await?;
    save_checkpoint_atomic(&deps.config, checkpoint).await?;

    let mut acts_to_process: Vec<NormattivaAtto> = acts
        .iter()
        .filter(|a| force || !checkpoint.act_versions.contains_key(&a.codice_redazionale))
        .cloned()
        .collect();
    acts_to_process.sort_by(|a, b| {
        let av = parse_iso_or_date(&a.data_gu).unwrap_or(0);
        let bv = parse_iso_or_date(&b.data_gu).unwrap_or(0);
        av.cmp(&bv)
    });
    for act in acts {
        if !force && checkpoint.act_versions.contains_key(&act.codice_redazionale) {
            deps.logger.log(&format!("Skipping {}", act.codice_redazionale));
        }
    }

    let fetch_total = acts_to_process.len();

    // Phase 1: parallel fetch (queue-gated).
    let mut set: JoinSet<(NormattivaAtto, Option<(String, String)>)> = JoinSet::new();
    for act in acts_to_process.iter().cloned() {
        let sem = sem.clone();
        let config = deps.config.clone();
        let sf = deps.safe_fetch.clone();
        let logger = deps.logger.clone();
        set.spawn(async move {
            let permit = sem.acquire_owned().await.expect("semaphore");
            let at_date = act.data_gu.clone();
            let atto = fetch_act_detail(&act, &at_date, &config, &sf, logger.as_ref(), "@originale").await;
            let result = atto.as_ref().map(to_plain_text);
            drop(permit);
            (act, result)
        });
    }

    let mut fetched: Vec<(NormattivaAtto, Option<(String, String)>)> = Vec::new();
    let mut fetch_done = 0usize;
    update_progress_status(
        deps.logger.as_ref(),
        checkpoint,
        eta_ctx,
        Some(&format!("fetch testi 0/{fetch_total}…")),
    );
    while let Some(j) = set.join_next().await {
        fetch_done += 1;
        update_progress_status(
            deps.logger.as_ref(),
            checkpoint,
            eta_ctx,
            Some(&format!("fetch testi {fetch_done}/{fetch_total}…")),
        );
        match j {
            Ok(t) => fetched.push(t),
            Err(err) => deps.logger.log(&format!("Fetch task fallito: {err}")),
        }
    }

    update_progress_status(deps.logger.as_ref(), checkpoint, eta_ctx, None);

    // Phase 2: serial commit.
    for (act, result) in fetched {
        if is_shutdown_requested(&deps.shutdown) {
            break;
        }
        let act_id = act.codice_redazionale.clone();
        if let Err(err) =
            commit_one_act(&act, result, checkpoint, deps, &mut updated_urns, sem.clone(), eta_ctx).await
        {
            deps.logger.log(&format!("Errore processing {act_id}: {err}"));
            save_checkpoint_atomic(&deps.config, checkpoint).await?;
        }
    }

    update_progress_status(deps.logger.as_ref(), checkpoint, eta_ctx, None);

    let _ = deps.git.push().await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn commit_one_act(
    act: &NormattivaAtto,
    result: Option<(String, String)>,
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
    updated_urns: &mut HashSet<String>,
    sem: Arc<Semaphore>,
    eta_ctx: Option<&EtaContext>,
) -> Result<()> {
    let vigenza_date = act.data_gu.clone();
    let mut ref_count: u32 = 0;

    let Some((raw, plain)) = result else {
        deps.logger.log(&format!(
            "Testo non disponibile per {} @ {vigenza_date}.",
            act.codice_redazionale
        ));
        checkpoint
            .act_versions
            .insert(act.codice_redazionale.clone(), enriched_entry(act, act.data_gu.clone(), 0));
        save_checkpoint_atomic(&deps.config, checkpoint).await?;
        update_progress_status(deps.logger.as_ref(), checkpoint, eta_ctx, None);
        return Ok(());
    };

    {
        if plain.is_empty() {
            deps.logger.log(&format!(
                "Testo vuoto per {} @ {vigenza_date}.",
                act.codice_redazionale
            ));
        } else {
            let safe_file_name = build_file_name(
                act.denominazione_atto.as_deref(),
                act.numero_provvedimento.as_deref(),
                act.giorno_provvedimento.as_deref(),
                act.mese_provvedimento.as_deref(),
                act.anno_provvedimento.as_deref(),
                &act.codice_redazionale,
            );
            let file_path: PathBuf =
                PathBuf::from(&deps.config.output_repo).join(&safe_file_name);
            let label = act.denominazione_atto.as_deref().unwrap_or("atto");
            let commit_msg = format!(
                "GU {} - {} - {label} {}",
                act.numero_gu.as_deref().unwrap_or(""),
                act.data_gu,
                act.codice_redazionale,
            );
            let commit_date = iso_to_date(&act.data_gu);

            let mut branchable = resolve_branchable_type(act);

            // Pre-1926 RDL "catastrofali": option (a). These had no automatic
            // decadenza and were ratified only by parliamentary praxis.
            // Branch only when a known ratifying law already exists in
            // Normattiva, otherwise direct-commit like a plain regio decreto.
            // This avoids creating branches that would never close.
            if let Some(info) = branchable {
                if info.short == BranchableShort::Rdl && info.deadline_days.is_none() {
                    let ratifier = fetch_conversion_law(
                        ConversionSearchContext::from_atto(act),
                        &deps.config,
                        &deps.safe_fetch,
                        deps.logger.as_ref(),
                    )
                    .await;
                    if ratifier.is_none() {
                        deps.logger.log(&format!(
                            "RDL pre-1926 {}: nessun ratificatore noto, commit diretto su history",
                            act.codice_redazionale
                        ));
                        branchable = None;
                    }
                }
            }

            if let Some(branchable) = branchable {
                let branch = branch_name_for(branchable.short, &act.codice_redazionale);
                if !deps.git.dl_branch_exists(&branch).await? {
                    deps.git.create_dl_branch(&branch).await?;
                } else {
                    deps.git.checkout_branch(&branch).await?;
                }

                fs::write(&file_path, &plain).await?;

                let branch_ref_files = write_relationship_files(
                    &act.codice_redazionale,
                    act,
                    &raw,
                    &safe_file_name,
                    &commit_date,
                    updated_urns,
                    deps,
                    sem.clone(),
                )
                .await;
                ref_count = branch_ref_files.len() as u32;

                let mut files: Vec<&str> = vec![safe_file_name.as_str()];
                files.extend(branch_ref_files.iter().map(String::as_str));
                deps.git.commit_local_multi(&files, &commit_msg, &commit_date).await?;
                let tag = branchable.short.upper();
                deps.logger.log(&format!(
                    "Committed {tag} {} on branch {branch} (+ {} refs)",
                    act.codice_redazionale, ref_count
                ));

                let entry = PendingAct {
                    codice_redazionale: act.codice_redazionale.clone(),
                    branch_name: branch,
                    data_gu: act.data_gu.clone(),
                    denominazione_atto: act.denominazione_atto.clone(),
                    numero_provvedimento: act.numero_provvedimento.clone(),
                    anno_provvedimento: act.anno_provvedimento.clone(),
                    short: branchable.short,
                    deadline_days: branchable.deadline_days,
                };
                let pending = ensure_pending_acts_migrated(checkpoint);
                pending.entry(act.codice_redazionale.clone()).or_insert(entry);

                deps.git.checkout().await?;
            } else {
                fs::write(&file_path, &plain).await?;
                let ref_files = write_relationship_files(
                    &act.codice_redazionale,
                    act,
                    &raw,
                    &safe_file_name,
                    &commit_date,
                    updated_urns,
                    deps,
                    sem.clone(),
                )
                .await;
                ref_count = ref_files.len() as u32;
                let mut files: Vec<&str> = vec![safe_file_name.as_str()];
                files.extend(ref_files.iter().map(String::as_str));
                deps.git.commit_local_multi(&files, &commit_msg, &commit_date).await?;
                deps.logger.log(&format!(
                    "Committed {} (+ {} refs)",
                    act.codice_redazionale, ref_count
                ));

                // Bulk-ratification trigger: when the LEGGE we just committed
                // is L. 473/1925 or L. 561/1956, octopus-merge every still-open
                // branch in scope into history with one merge commit.
                if let Some(sanatoria) = find_sanatoria_law(act) {
                    apply_sanatoria(sanatoria, &commit_date, checkpoint, deps).await?;
                }
            }
        }
    }

    checkpoint
        .act_versions
        .insert(act.codice_redazionale.clone(), enriched_entry(act, act.data_gu.clone(), ref_count));
    deps.logger.update_refs(&act.codice_redazionale, ref_count);
    save_checkpoint_atomic(&deps.config, checkpoint).await?;
    record_completion();
    update_progress_status(deps.logger.as_ref(), checkpoint, eta_ctx, None);

    let _ = (Value::Null,); // appease unused-import lints in some configs
    Ok(())
}

// ---- Phase B: process_modified_acts -----------------------------------------

pub async fn process_modified_acts(
    from: NaiveDate,
    to: NaiveDate,
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
    eta_ctx: Option<&EtaContext>,
) -> Result<()> {
    let _span = tracing::info_span!("process", op = "processModifiedActs",
        from = %from, to = %to).entered();
    let mut updated_urns: HashSet<String> = HashSet::new();
    let sem = Arc::new(Semaphore::new(num_cpus::get().max(1)));

    let modified =
        fetch_updated_acts(from, to, &deps.config, &deps.safe_fetch, deps.logger.as_ref()).await;
    if modified.is_empty() {
        return Ok(());
    }

    let mut to_update: Vec<NormattivaAtto> = modified
        .into_iter()
        .filter(|act| {
            let Some(committed) = checkpoint.act_versions.get(&act.codice_redazionale) else {
                return false;
            };
            let Some(mod_date) = act.data_ultima_modifica.as_deref() else { return false };
            committed.date.as_str() < mod_date
        })
        .collect();
    to_update.sort_by(|a, b| {
        let av = parse_iso_or_date(a.data_ultima_modifica.as_deref().unwrap_or("")).unwrap_or(0);
        let bv = parse_iso_or_date(b.data_ultima_modifica.as_deref().unwrap_or("")).unwrap_or(0);
        av.cmp(&bv)
    });

    if to_update.is_empty() {
        return Ok(());
    }

    deps.logger.log(&format!(
        "Phase B: {} atti modificati in {}",
        to_update.len(),
        from.format("%Y-%m")
    ));
    let fetch_total = to_update.len();
    deps.git.checkout().await?;

    type ModFetched = (NormattivaAtto, Option<(String, String)>, String);
    let mut set: JoinSet<ModFetched> = JoinSet::new();
    for act in to_update.iter().cloned() {
        let sem = sem.clone();
        let config = deps.config.clone();
        let sf = deps.safe_fetch.clone();
        let logger = deps.logger.clone();
        set.spawn(async move {
            let permit = sem.acquire_owned().await.expect("semaphore");
            let mod_date = act.data_ultima_modifica.clone().unwrap_or_default();
            let vig_date = vigenza_after(&mod_date);
            let suffix = format!("!vig={vig_date}");
            let atto = fetch_act_detail(&act, &mod_date, &config, &sf, logger.as_ref(), &suffix).await;
            let result = atto.as_ref().map(to_plain_text);
            drop(permit);
            (act, result, mod_date)
        });
    }

    let mut fetched: Vec<ModFetched> = Vec::new();
    let mut fetch_done = 0usize;
    update_progress_status(
        deps.logger.as_ref(),
        checkpoint,
        eta_ctx,
        Some(&format!("Phase B — fetch testi 0/{fetch_total}…")),
    );
    while let Some(j) = set.join_next().await {
        fetch_done += 1;
        update_progress_status(
            deps.logger.as_ref(),
            checkpoint,
            eta_ctx,
            Some(&format!("Phase B — fetch testi {fetch_done}/{fetch_total}…")),
        );
        if let Ok(t) = j {
            fetched.push(t);
        }
    }

    update_progress_status(deps.logger.as_ref(), checkpoint, eta_ctx, None);

    for (act, result, mod_date) in fetched {
        let Some((raw, plain)) = result else { continue };
        if plain.is_empty() {
            deps.logger.log(&format!(
                "Testo vuoto per modifica {} @ {mod_date}.",
                act.codice_redazionale
            ));
            continue;
        }
        if plain.contains("NON ANCORA ESISTENTE O VIGENTE") {
            deps.logger.log(&format!(
                "Skipping modifica {} @ {mod_date}: atto non ancora in vigore.",
                act.codice_redazionale
            ));
            continue;
        }

        let act_id = act.codice_redazionale.clone();
        let res =
            commit_modification(&act, &raw, &plain, &mod_date, checkpoint, deps, &mut updated_urns, sem.clone())
                .await;
        if let Err(err) = res {
            deps.logger.log(&format!("Errore modifica {act_id}: {err}"));
            save_checkpoint_atomic(&deps.config, checkpoint).await?;
        } else {
            update_progress_status(deps.logger.as_ref(), checkpoint, eta_ctx, None);
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn commit_modification(
    act: &NormattivaAtto,
    raw: &str,
    plain: &str,
    mod_date: &str,
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
    updated_urns: &mut HashSet<String>,
    sem: Arc<Semaphore>,
) -> Result<()> {
    let safe_file_name = build_file_name(
        act.denominazione_atto.as_deref(),
        act.numero_provvedimento.as_deref(),
        act.giorno_provvedimento.as_deref(),
        act.mese_provvedimento.as_deref(),
        act.anno_provvedimento.as_deref(),
        &act.codice_redazionale,
    );
    let file_path = PathBuf::from(&deps.config.output_repo).join(&safe_file_name);
    let label = act.denominazione_atto.as_deref().unwrap_or("atto");
    let commit_date = iso_to_date(mod_date);
    let commit_msg = format!("Modifica: {label} {} @ {commit_date}", act.codice_redazionale);

    fs::write(&file_path, plain).await?;

    let ref_files = write_relationship_files(
        &act.codice_redazionale,
        act,
        raw,
        &safe_file_name,
        &commit_date,
        updated_urns,
        deps,
        sem,
    )
    .await;
    let mut files: Vec<&str> = vec![safe_file_name.as_str()];
    files.extend(ref_files.iter().map(String::as_str));
    deps.git.commit_local_multi(&files, &commit_msg, &commit_date).await?;
    deps.logger.log(&format!(
        "Committed modifica {} @ {commit_date} (+ {} refs)",
        act.codice_redazionale,
        ref_files.len()
    ));

    let refs_count = ref_files.len() as u32;
    checkpoint
        .act_versions
        .insert(act.codice_redazionale.clone(), enriched_entry(act, mod_date.to_string(), refs_count));
    deps.logger.update_refs(&act.codice_redazionale, refs_count);
    save_checkpoint_atomic(&deps.config, checkpoint).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legge(anno: &str, numero: &str) -> NormattivaAtto {
        NormattivaAtto {
            denominazione_atto: Some("LEGGE".to_string()),
            anno_provvedimento: Some(anno.to_string()),
            numero_provvedimento: Some(numero.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn find_sanatoria_matches_l_473_1925() {
        let s = find_sanatoria_law(&legge("1925", "473")).expect("L. 473/1925 should match");
        assert_eq!(s.label, "L. 473/1925");
        assert_eq!(s.from_date, "0001-01-01");
        assert_eq!(s.to_date, "1924-05-23");
        assert!(s.covers_shorts.contains(&BranchableShort::Dll));
        assert!(s.covers_shorts.contains(&BranchableShort::Rdl));
    }

    #[test]
    fn find_sanatoria_matches_l_561_1956() {
        let s = find_sanatoria_law(&legge("1956", "561")).expect("L. 561/1956 should match");
        assert_eq!(s.label, "L. 561/1956");
        assert_eq!(s.from_date, "1944-06-25");
        assert_eq!(s.to_date, "1947-12-31");
        assert!(s.covers_shorts.contains(&BranchableShort::Dll));
        assert!(s.covers_shorts.contains(&BranchableShort::Dlcps));
    }

    #[test]
    fn find_sanatoria_misses_unrelated_legge() {
        // Same year, different number → not a sanatoria.
        assert!(find_sanatoria_law(&legge("1925", "474")).is_none());
        // Same number, different year.
        assert!(find_sanatoria_law(&legge("1924", "473")).is_none());
        // Random LEGGE.
        assert!(find_sanatoria_law(&legge("2020", "77")).is_none());
    }

    #[test]
    fn find_sanatoria_rejects_non_legge() {
        // Even if the (anno, numero) matches a sanatoria, only LEGGE qualifies.
        let mut act = legge("1925", "473");
        act.denominazione_atto = Some("REGIO DECRETO".to_string());
        assert!(find_sanatoria_law(&act).is_none());
    }

    #[test]
    fn find_sanatoria_handles_missing_metadata() {
        let mut act = legge("1925", "473");
        act.numero_provvedimento = None;
        assert!(find_sanatoria_law(&act).is_none());
        act.numero_provvedimento = Some("473".to_string());
        act.anno_provvedimento = None;
        assert!(find_sanatoria_law(&act).is_none());
        act.anno_provvedimento = Some("1925".to_string());
        act.denominazione_atto = None;
        assert!(find_sanatoria_law(&act).is_none());
    }

    #[test]
    fn date_in_range_inclusive_bounds() {
        // Lower bound inclusive.
        assert!(date_in_range("1944-06-25", "1944-06-25", "1947-12-31"));
        // Upper bound inclusive.
        assert!(date_in_range("1947-12-31", "1944-06-25", "1947-12-31"));
        // Inside.
        assert!(date_in_range("1945-04-15", "1944-06-25", "1947-12-31"));
        // Just before.
        assert!(!date_in_range("1944-06-24", "1944-06-25", "1947-12-31"));
        // Just after.
        assert!(!date_in_range("1948-01-01", "1944-06-25", "1947-12-31"));
    }

    #[test]
    fn date_in_range_handles_iso_datetime_prefix() {
        // ISO datetime strings (Normattiva sometimes returns them) are
        // compared by their leading 10-byte YYYY-MM-DD prefix.
        assert!(date_in_range("1945-04-15T00:00:00Z", "1944-06-25", "1947-12-31"));
        assert!(!date_in_range("1948-01-01T00:00:00Z", "1944-06-25", "1947-12-31"));
    }

    #[test]
    fn marker_file_name_preserves_legacy_dl_format() {
        // Modern DL keeps the flat <codice>.decaduto for parity with the 418
        // existing markers in the corpus.
        assert_eq!(marker_file_name("077U0019", BranchableShort::Dl), "077U0019.decaduto");
    }

    #[test]
    fn marker_file_name_uses_typed_form_for_new_namespaces() {
        assert_eq!(
            marker_file_name("925U1234", BranchableShort::Rdl),
            "925U1234.rdl.decaduto"
        );
        assert_eq!(
            marker_file_name("044U0203", BranchableShort::Dll),
            "044U0203.dll.decaduto"
        );
        assert_eq!(
            marker_file_name("046U0500", BranchableShort::Dlcps),
            "046U0500.dlcps.decaduto"
        );
    }

    #[test]
    fn has_lapsed_returns_false_when_no_deadline() {
        // Pre-1926 RDL and 1944–46 DLL/DLCPS have deadline_days = None and
        // must NEVER lapse on a timer — only on explicit abrogation.
        let act = PendingAct {
            codice_redazionale: "x".to_string(),
            branch_name: "rdl-rs/x".to_string(),
            data_gu: "1908-12-28".to_string(),
            denominazione_atto: Some("REGIO DECRETO-LEGGE".to_string()),
            numero_provvedimento: Some("740".to_string()),
            anno_provvedimento: Some("1908".to_string()),
            short: BranchableShort::Rdl,
            deadline_days: None,
        };
        // In_force / updated → no lapse, regardless of how old the act is.
        assert!(!has_lapsed(&act, ActStatus::InForce));
        assert!(!has_lapsed(&act, ActStatus::Updated));
        // But explicit abrogation does lapse it.
        assert!(has_lapsed(&act, ActStatus::Abrogated));
    }
}
