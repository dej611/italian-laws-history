use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{Datelike, NaiveDate, Utc};
use clap::Parser;
use tokio_stream::StreamExt;

mod api;
mod checkpoint;
mod config;
mod git;
mod http;
mod logger;
mod processor;
mod tracing_setup;
mod types;

use crate::api::{monthly_windows, scrape_month};
use crate::checkpoint::{load_checkpoint, save_checkpoint_atomic};
use crate::config::load_config;
use crate::git::GitHelpers;
use crate::http::SafeFetch;
use crate::logger::{build_logger, is_shutdown_requested, LoggerHandle, ShutdownSignal};
use crate::processor::{
    process_batches, process_modified_acts, record_month_completed, EtaContext, ProcessorDeps,
};

#[derive(Parser, Debug)]
#[command(version, about = "Track Italian law changes via Normattiva (Rust port)")]
struct Args {
    /// Optional explicit since-date (YYYY-MM-DD); overrides checkpoint.
    since_date: Option<String>,

    /// Reprocess all acts, ignoring checkpoint.
    #[arg(long)]
    force: bool,

    /// CI mode: no TUI, plain stdout logger. Alias: --headless.
    #[arg(long, alias = "headless")]
    ci: bool,

    /// Emit Chrome trace JSON (trace-*.json).
    #[arg(long)]
    perf: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let _trace_guard = tracing_setup::init(args.perf);

    let config = Arc::new(load_config());
    let (shutdown, shutdown_rx) = ShutdownSignal::new();
    let LoggerHandle { logger, tui_task } = build_logger(args.ci, ".", shutdown.clone()).await?;
    let git = Arc::new(GitHelpers::new(config.clone()));
    let safe_fetch = Arc::new(SafeFetch::new(config.clone(), logger.clone())?);

    let shutdown_ctrlc = shutdown.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            shutdown_ctrlc.request();
        }
    });

    let result = run(
        args,
        config,
        logger.clone(),
        git.clone(),
        safe_fetch,
        shutdown_rx,
    )
    .await;

    // Best-effort cleanup, mirroring the TS process.on('exit', ...) handler.
    git.checkout_main_sync();

    if let Some(handle) = tui_task {
        // Ask the TUI to shut down and wait briefly for the terminal to be restored.
        logger.shutdown();
        let _ = handle.await;
    }

    if let Err(err) = &result {
        logger.set_status("ERRORE");
        eprintln!("Errore esecuzione: {err:#}");
    }
    result
}

async fn run(
    args: Args,
    config: Arc<crate::types::Config>,
    logger: Arc<dyn crate::logger::Logger>,
    git: Arc<GitHelpers>,
    safe_fetch: Arc<SafeFetch>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    git.ensure_repo().await?;
    git.ensure_history_branch().await?;

    let mut checkpoint = load_checkpoint(&config).await?;
    if args.force {
        logger.log("Forzando rielaborazione completa: ignorando checkpoint.");
        checkpoint.act_versions.clear();
        checkpoint.last_fully_scanned_date = None;
    }

    checkpoint.last_run = Some(Utc::now().to_rfc3339());

    let since_date = args
        .since_date
        .clone()
        .or_else(|| checkpoint.last_fully_scanned_date.clone())
        .unwrap_or_else(|| "1861-01-01".to_string());

    logger.log(&format!(
        "Checkpoint caricato: {} atti già processati.",
        checkpoint.act_versions.len()
    ));
    logger.seed_charts(&checkpoint.act_versions);
    logger.log(&format!("Scraping atti dal {since_date} ad oggi..."));

    let deps = ProcessorDeps {
        config: config.clone(),
        logger: logger.clone(),
        safe_fetch: safe_fetch.clone(),
        git: git.clone(),
        shutdown: shutdown_rx.clone(),
    };

    let mut total_processed: usize = 0;
    let now = Utc::now().date_naive();

    for (from, to) in monthly_windows(&since_date)? {
        if is_shutdown_requested(&shutdown_rx) {
            return graceful_shutdown(&config, &checkpoint, &logger).await;
        }

        let window_label = format!("{:04}-{:02}", from.year(), from.month());
        let _span = tracing::info_span!("loop", op = "monthlyWindow", window = %window_label).entered();
        let mut month_act_count: usize = 0;
        let remaining_months = months_between(from, now).max(0) as u32;

        let stream = scrape_month(from, to, config.clone(), safe_fetch.clone(), logger.clone());
        tokio::pin!(stream);
        while let Some(batch_res) = stream.next().await {
            if is_shutdown_requested(&shutdown_rx) {
                return graceful_shutdown(&config, &checkpoint, &logger).await;
            }
            let batch = batch_res?;
            let eta = EtaContext {
                current_window_date: Some(from),
                remaining_months,
            };
            process_batches(&batch, &mut checkpoint, args.force, &deps, Some(&eta)).await?;
            total_processed += batch.len();
            month_act_count += batch.len();
        }

        record_month_completed(month_act_count as u32);

        process_modified_acts(from, to, &mut checkpoint, &deps).await?;

        checkpoint.last_fully_scanned_date = Some(format!("{}", from.format("%Y-%m-%d")));
        save_checkpoint_atomic(&config, &checkpoint)
            .await
            .with_context(|| "saving checkpoint")?;
    }

    if total_processed == 0 {
        logger.log("Nessun atto trovato nel periodo indicato.");
        return Ok(());
    }

    logger.log("Elaborazione completata.");
    logger.set_status("COMPLETATO");
    Ok(())
}

fn months_between(from: NaiveDate, to: NaiveDate) -> i32 {
    (to.year() - from.year()) * 12 + (to.month() as i32 - from.month() as i32)
}

async fn graceful_shutdown(
    config: &Arc<crate::types::Config>,
    checkpoint: &crate::types::Checkpoint,
    logger: &Arc<dyn crate::logger::Logger>,
) -> Result<()> {
    logger.log("Interruzione richiesta — salvataggio checkpoint…");
    save_checkpoint_atomic(config, checkpoint)
        .await
        .with_context(|| "saving checkpoint on shutdown")?;
    logger.set_status("INTERROTTO");
    Ok(())
}
