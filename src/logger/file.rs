use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::Utc;

use crate::logger::Logger;
use crate::types::{ActVersionEntry, NormattivaAtto};

/// Append-only daily log file: `processing-YYYY-MM-DD.log`.
pub struct FileLog {
    file: Mutex<File>,
}

impl FileLog {
    pub fn open(dir: &str) -> std::io::Result<Self> {
        let date = Utc::now().format("%Y-%m-%d");
        let path: PathBuf = PathBuf::from(dir).join(format!("processing-{date}.log"));
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(f, "\n=== Run started {} ===", Utc::now().to_rfc3339())?;
        Ok(Self { file: Mutex::new(f) })
    }

    fn write(&self, msg: &str) {
        if let Ok(mut f) = self.file.lock() {
            let _ = writeln!(f, "[{}] {msg}", Utc::now().to_rfc3339());
        }
    }
}

/// Tees every Logger call onto an inner logger AND a file.
pub struct FileLogWrapper {
    inner: Arc<dyn Logger>,
    file: FileLog,
}

impl FileLogWrapper {
    pub fn new(inner: Arc<dyn Logger>, file: FileLog) -> Self {
        Self { inner, file }
    }
}

impl Logger for FileLogWrapper {
    fn log(&self, msg: &str) {
        self.inner.log(msg);
        self.file.write(msg);
    }
    fn log_file(&self, msg: &str) {
        // bypass the inner logger; only persist to disk
        self.file.write(msg);
    }
    fn set_status(&self, status: &str) {
        self.inner.set_status(status);
        self.file.write(&format!("[STATUS] {status}"));
    }
    fn update_list(&self, items: &[NormattivaAtto]) {
        self.inner.update_list(items);
        self.file.write(&format!("Trovati {} atti aggiornati", items.len()));
    }
    fn seed_charts(&self, versions: &HashMap<String, ActVersionEntry>) {
        self.inner.seed_charts(versions);
    }
    fn update_refs(&self, codice: &str, refs: u32) {
        self.inner.update_refs(codice, refs);
    }
    fn shutdown(&self) {
        self.inner.shutdown();
    }
}
