use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::types::{ActVersionEntry, NormattivaAtto};

pub mod ci;
pub mod file;
pub mod tui;

/// Cooperative shutdown flag shared by the TUI, Ctrl-C handler, and scraper loop.
#[derive(Clone)]
pub struct ShutdownSignal {
    tx: watch::Sender<bool>,
}

impl ShutdownSignal {
    pub fn new() -> (Self, watch::Receiver<bool>) {
        let (tx, rx) = watch::channel(false);
        (Self { tx }, rx)
    }

    pub fn request(&self) {
        let _ = self.tx.send(true);
    }
}

pub fn is_shutdown_requested(rx: &watch::Receiver<bool>) -> bool {
    *rx.borrow()
}

/// User-facing logging surface — also drives the TUI when one is attached.
pub trait Logger: Send + Sync {
    fn log(&self, msg: &str);
    /// Write only to the on-disk log file (no TUI / stdout). No-op when there is no file log.
    fn log_file(&self, msg: &str);
    fn set_status(&self, status: &str);
    fn update_list(&self, _items: &[NormattivaAtto]) {}
    fn seed_charts(&self, _versions: &HashMap<String, ActVersionEntry>) {}
    fn update_refs(&self, _codice: &str, _refs: u32) {}
    /// Best-effort signal that the program is shutting down: used by the TUI
    /// logger to restore the terminal. Default no-op for plain loggers.
    fn shutdown(&self) {}
}

pub struct LoggerHandle {
    pub logger: Arc<dyn Logger>,
    /// Set when a TUI is running; awaited by `main` after shutdown.
    pub tui_task: Option<JoinHandle<()>>,
}

/// Construct the logger stack: TUI (if available) or CI logger, both wrapped
/// with a daily file-log appender (`processing-YYYY-MM-DD-rs.log`).
pub async fn build_logger(
    ci_mode: bool,
    log_dir: &str,
    shutdown: ShutdownSignal,
) -> Result<LoggerHandle> {
    let file_layer = file::FileLog::open(log_dir).ok();

    if ci_mode {
        let inner: Arc<dyn Logger> = Arc::new(ci::CiLogger);
        let logger: Arc<dyn Logger> = match file_layer {
            Some(fl) => Arc::new(file::FileLogWrapper::new(inner, fl)),
            None => inner,
        };
        return Ok(LoggerHandle { logger, tui_task: None });
    }

    match tui::try_start(shutdown).await {
        Some((tui_logger, handle)) => {
            let inner: Arc<dyn Logger> = Arc::new(tui_logger);
            let logger: Arc<dyn Logger> = match file_layer {
                Some(fl) => Arc::new(file::FileLogWrapper::new(inner, fl)),
                None => inner,
            };
            Ok(LoggerHandle { logger, tui_task: Some(handle) })
        }
        None => {
            let inner: Arc<dyn Logger> = Arc::new(ci::CiLogger);
            let logger: Arc<dyn Logger> = match file_layer {
                Some(fl) => Arc::new(file::FileLogWrapper::new(inner, fl)),
                None => inner,
            };
            Ok(LoggerHandle { logger, tui_task: None })
        }
    }
}
