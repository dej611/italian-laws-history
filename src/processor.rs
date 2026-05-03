use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Result;
use chrono::{NaiveDate, Utc};
use serde_json::Value;
use tokio::fs;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::api::detail::{
    fetch_act_detail, fetch_act_detail_by_urn, fetch_act_status, fetch_conversion_law,
};
use crate::api::search::fetch_updated_acts;
use crate::api::text::{
    atto_file_name, build_file_name, extract_urns, html_to_plain_text, is_decreto_legge,
    to_plain_text,
};
use crate::checkpoint::save_checkpoint_atomic;
use crate::git::{dl_branch_name, GitHelpers};
use crate::http::SafeFetch;
use crate::logger::Logger;
use crate::types::{
    ActStatus, ActVersionEntry, AttoDto, Checkpoint, Config, NormattivaAtto, PendingDl,
};

const DL_LAPSE_SECS: i64 = 60 * 24 * 60 * 60; // 60 days
const ETA_MONTH_WINDOW: usize = 6;
const RATE_WINDOW_MS: u128 = 5 * 60 * 1000; // 5 minutes

#[derive(Clone)]
pub struct ProcessorDeps {
    pub config: Arc<Config>,
    pub logger: Arc<dyn Logger>,
    pub safe_fetch: Arc<SafeFetch>,
    pub git: Arc<GitHelpers>,
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

fn has_lapsed(dl: &PendingDl, status: ActStatus) -> bool {
    if status == ActStatus::Abrogated {
        return true;
    }
    let Some(parsed) = parse_iso_or_date(&dl.data_gu) else { return false };
    let now = Utc::now().timestamp();
    now - parsed > DL_LAPSE_SECS
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
            let versioned = format!("{urn}!vig={before_date}");
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

// ---- DL reconciliation ------------------------------------------------------

pub async fn reconcile_pending_decreti_legge(
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
    updated_urns: &mut HashSet<String>,
    sem: Arc<Semaphore>,
) -> Result<()> {
    let _span = tracing::info_span!("process", op = "reconcileDL").entered();
    let pending = checkpoint
        .pending_decreti_legge
        .clone()
        .unwrap_or_default();
    let mut still_pending: HashMap<String, PendingDl> = HashMap::new();

    for (codice, dl) in pending.into_iter() {
        deps.logger.log(&format!("Riconciliazione DL {codice}…"));

        let conv =
            fetch_conversion_law(&codice, &deps.config, &deps.safe_fetch, deps.logger.as_ref())
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
                "DL {codice} convertito — merge in history (${merge_date})"
            ));
            deps.git
                .merge_dl_branch(&dl.branch_name, &merge_msg, &merge_date)
                .await?;

            let safe_file_name = build_file_name(
                dl.denominazione_atto.as_deref(),
                dl.numero_provvedimento.as_deref(),
                None,
                None,
                dl.anno_provvedimento.as_deref(),
                &codice,
            );

            let act_stub = NormattivaAtto {
                codice_redazionale: dl.codice_redazionale.clone(),
                data_gu: dl.data_gu.clone(),
                denominazione_atto: dl.denominazione_atto.clone(),
                numero_provvedimento: dl.numero_provvedimento.clone(),
                anno_provvedimento: dl.anno_provvedimento.clone(),
                ..Default::default()
            };

            if let Some(dl_atto) = fetch_act_detail(
                &act_stub,
                &dl.data_gu,
                &deps.config,
                &deps.safe_fetch,
                deps.logger.as_ref(),
                "@originale",
            )
            .await
            {
                let (raw, _plain) = to_plain_text(&dl_atto);
                let ref_files = write_relationship_files(
                    &codice,
                    &act_stub,
                    &raw,
                    &safe_file_name,
                    &iso_to_date(&dl.data_gu),
                    updated_urns,
                    deps,
                    sem.clone(),
                )
                .await;
                if !ref_files.is_empty() {
                    let refs: Vec<&str> = ref_files.iter().map(String::as_str).collect();
                    deps.git
                        .commit_local_multi(&refs, &format!("Riferimenti DL {codice}"), &merge_date)
                        .await?;
                    deps.logger.log(&format!(
                        "Committed {} refs for DL {codice}",
                        ref_files.len()
                    ));
                }
            }

            deps.git.delete_dl_branch(&dl.branch_name).await?;
        } else {
            let status = fetch_act_status(
                &NormattivaAtto {
                    codice_redazionale: codice.clone(),
                    data_gu: dl.data_gu.clone(),
                    ..Default::default()
                },
                &deps.config,
                &deps.safe_fetch,
                deps.logger.as_ref(),
            )
            .await;

            if has_lapsed(&dl, status) {
                let today = Utc::now().format("%Y-%m-%d").to_string();
                let merge_msg = format!(
                    "DECADUTO: {} {} n. {}",
                    dl.denominazione_atto.as_deref().unwrap_or("DECRETO-LEGGE"),
                    dl.anno_provvedimento.as_deref().unwrap_or(""),
                    dl.numero_provvedimento.as_deref().unwrap_or(&codice),
                );
                deps.logger.log(&format!(
                    "DL {codice} decaduto — merge DECADUTO in history"
                ));

                deps.git.checkout_branch(&dl.branch_name).await?;
                let marker_name = format!("{codice}.decaduto");
                let marker_path: PathBuf =
                    PathBuf::from(&deps.config.output_repo).join(&marker_name);
                fs::write(
                    &marker_path,
                    format!(
                        "Decreto-Legge {codice} decaduto per mancata conversione.\n"
                    ),
                )
                .await?;
                deps.git
                    .commit_local(
                        &marker_name,
                        &format!("Marcatore: DL {codice} non convertito"),
                        &today,
                    )
                    .await?;

                deps.git.merge_dl_branch(&dl.branch_name, &merge_msg, &today).await?;
                deps.git.delete_dl_branch(&dl.branch_name).await?;
            } else {
                deps.logger.log(&format!("DL {codice} ancora in attesa di conversione."));
                still_pending.insert(codice, dl);
            }
        }
    }

    if still_pending.is_empty() {
        checkpoint.pending_decreti_legge = None;
    } else {
        checkpoint.pending_decreti_legge = Some(still_pending);
    }
    Ok(())
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
    let mut updated_urns: HashSet<String> = HashSet::new();
    let sem = Arc::new(Semaphore::new(num_cpus::get().max(1)));

    deps.git.checkout().await?;
    deps.git.pull().await?;

    deps.logger.update_list(acts);

    reconcile_pending_decreti_legge(checkpoint, deps, &mut updated_urns, sem.clone()).await?;
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
    while let Some(j) = set.join_next().await {
        match j {
            Ok(t) => fetched.push(t),
            Err(err) => deps.logger.log(&format!("Fetch task fallito: {err}")),
        }
    }

    // Phase 2: serial commit.
    for (act, result) in fetched {
        let act_id = act.codice_redazionale.clone();
        if let Err(err) =
            commit_one_act(&act, result, checkpoint, deps, &mut updated_urns, sem.clone(), eta_ctx).await
        {
            deps.logger.log(&format!("Errore processing {act_id}: {err}"));
            save_checkpoint_atomic(&deps.config, checkpoint).await?;
        }
    }

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

            if is_decreto_legge(act) {
                let branch = dl_branch_name(&act.codice_redazionale);
                if !deps.git.dl_branch_exists(&branch).await? {
                    deps.git.create_dl_branch(&branch).await?;
                } else {
                    deps.git.checkout_branch(&branch).await?;
                }

                fs::write(&file_path, &plain).await?;

                let dl_ref_files = write_relationship_files(
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
                ref_count = dl_ref_files.len() as u32;

                let mut files: Vec<&str> = vec![safe_file_name.as_str()];
                files.extend(dl_ref_files.iter().map(String::as_str));
                deps.git.commit_local_multi(&files, &commit_msg, &commit_date).await?;
                deps.logger.log(&format!(
                    "Committed DL {} on branch {branch} (+ {} refs)",
                    act.codice_redazionale, ref_count
                ));

                let entry = PendingDl {
                    codice_redazionale: act.codice_redazionale.clone(),
                    branch_name: branch,
                    data_gu: act.data_gu.clone(),
                    denominazione_atto: act.denominazione_atto.clone(),
                    numero_provvedimento: act.numero_provvedimento.clone(),
                    anno_provvedimento: act.anno_provvedimento.clone(),
                };
                let pending = checkpoint
                    .pending_decreti_legge
                    .get_or_insert_with(HashMap::new);
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
            }
        }
    }

    checkpoint
        .act_versions
        .insert(act.codice_redazionale.clone(), enriched_entry(act, act.data_gu.clone(), ref_count));
    deps.logger.update_refs(&act.codice_redazionale, ref_count);
    save_checkpoint_atomic(&deps.config, checkpoint).await?;
    record_completion();

    let processed = checkpoint.act_versions.len();
    let remaining_days = eta_ctx
        .and_then(|c| c.current_window_date)
        .map(|d| (Utc::now().date_naive() - d).num_days());
    let remaining_str = remaining_days.map(|n| format!(" — {n} giorni rimasti")).unwrap_or_default();
    let rate = current_rate_per_minute();
    let rate_str = rate.map(|r| format!(" — {r:.1} atti/min")).unwrap_or_default();
    let eta = eta_ctx.and_then(|c| compute_eta(c.remaining_months, processed));
    let (count_str, eta_str) = match eta {
        Some(e) => (format!("{processed} / ~{}", e.estimated_total), format!(" — ETA {}", e.eta)),
        None => (format!("{processed}"), String::new()),
    };
    deps.logger.set_status(&format!(
        "Elaborati {count_str}{remaining_str}{rate_str}{eta_str}"
    ));

    let _ = (Value::Null,); // appease unused-import lints in some configs
    Ok(())
}

// ---- Phase B: process_modified_acts -----------------------------------------

pub async fn process_modified_acts(
    from: NaiveDate,
    to: NaiveDate,
    checkpoint: &mut Checkpoint,
    deps: &ProcessorDeps,
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
    while let Some(j) = set.join_next().await {
        if let Ok(t) = j {
            fetched.push(t);
        }
    }

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
