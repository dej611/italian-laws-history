use chrono::Utc;

use crate::logger::Logger;
use crate::types::NormattivaAtto;

pub struct CiLogger;

fn stamp() -> String {
    Utc::now().to_rfc3339()
}

impl Logger for CiLogger {
    fn log(&self, msg: &str) {
        println!("[{}] {msg}", stamp());
    }
    fn log_file(&self, _msg: &str) {}
    fn set_status(&self, status: &str) {
        println!("{status}");
    }
    fn update_list(&self, items: &[NormattivaAtto]) {
        println!("[{}] Trovati {} atti aggiornati", stamp(), items.len());
    }
}
