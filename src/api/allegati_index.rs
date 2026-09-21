//! Disk index of which acts have allegati, built from a prior `history` scrape.
//!
//! File format (`allegati.json`, gitignored):
//! `{ "dataUntil": "YYYY-MM-DD", "allegati": { "<urn>": true, ... } }`
//!
//! Only positives are stored. An act whose GU date is on or before `dataUntil`
//! and whose URN is missing is treated as having no allegato — that is the
//! expensive miss we want to skip. Acts after `dataUntil` (or with no index
//! file) fall through to live URN probes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::logger::Logger;
use crate::types::Config;

pub const ALLEGATI_INDEX_FILE: &str = "allegati.json";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllegatiIndex {
    #[serde(default)]
    pub data_until: String,
    #[serde(default)]
    pub allegati: HashMap<String, bool>,
}

impl AllegatiIndex {
    pub fn load_from_path(path: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Skip the `:1~art1` existence probe.
    ///
    /// - explicit `false`, or missing from the map with `gu_date <= dataUntil` → skip
    /// - explicit `true`, unknown date, or `gu_date > dataUntil` → probe
    pub fn skip_probe(&self, urn: &str, gu_date: &str) -> bool {
        match self.allegati.get(urn) {
            Some(true) => false,
            Some(false) => true,
            None => {
                !self.data_until.is_empty()
                    && !gu_date.is_empty()
                    && gu_date <= self.data_until.as_str()
            }
        }
    }
}

/// Load `output_repo/allegati.json` once. Missing or malformed → empty index
/// (live probes, same as today).
pub fn get(config: &Config, logger: &dyn Logger) -> &'static AllegatiIndex {
    static INDEX: OnceLock<AllegatiIndex> = OnceLock::new();
    INDEX.get_or_init(|| {
        let path = Path::new(&config.output_repo).join(ALLEGATI_INDEX_FILE);
        match AllegatiIndex::load_from_path(&path) {
            Some(idx) => {
                let n = idx.allegati.values().filter(|v| **v).count();
                logger.log(&format!(
                    "Indice allegati: {n} atti con allegato, valido fino a {}",
                    idx.data_until
                ));
                idx
            }
            None => AllegatiIndex::default(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn idx(until: &str, pairs: &[(&str, bool)]) -> AllegatiIndex {
        AllegatiIndex {
            data_until: until.to_string(),
            allegati: pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), *v))
                .collect(),
        }
    }

    #[test]
    fn known_positive_always_probes() {
        let i = idx("2024-11-30", &[("urn:nir:stato:legge:1861-01-01;1", true)]);
        assert!(!i.skip_probe("urn:nir:stato:legge:1861-01-01;1", "1861-01-01"));
        assert!(!i.skip_probe("urn:nir:stato:legge:1861-01-01;1", "2025-01-01"));
    }

    #[test]
    fn known_negative_skips() {
        let i = idx("2024-11-30", &[("urn:nir:stato:legge:1861-01-01;1", false)]);
        assert!(i.skip_probe("urn:nir:stato:legge:1861-01-01;1", "1861-01-01"));
    }

    #[test]
    fn absent_on_or_before_data_until_skips() {
        let i = idx("2024-11-30", &[]);
        assert!(i.skip_probe("urn:nir:stato:legge:2000-01-01;1", "2000-01-01"));
        assert!(i.skip_probe("urn:nir:stato:legge:2000-01-01;1", "2024-11-30"));
    }

    #[test]
    fn absent_after_data_until_probes() {
        let i = idx("2024-11-30", &[]);
        assert!(!i.skip_probe("urn:nir:stato:legge:2024-12-01;1", "2024-12-01"));
    }

    #[test]
    fn empty_index_never_skips() {
        let i = AllegatiIndex::default();
        assert!(!i.skip_probe("urn:nir:stato:legge:1861-01-01;1", "1861-01-01"));
    }

    #[test]
    fn empty_gu_date_does_not_skip() {
        let i = idx("2024-11-30", &[]);
        assert!(!i.skip_probe("urn:nir:stato:legge:1861-01-01;1", ""));
    }

    #[test]
    fn load_from_path_reads_camel_case() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(
            br#"{"dataUntil":"2024-11-30","allegati":{"urn:nir:stato:legge:1861-04-21;1":true}}"#,
        )
        .unwrap();
        let loaded = AllegatiIndex::load_from_path(tmp.path()).unwrap();
        assert_eq!(loaded.data_until, "2024-11-30");
        assert_eq!(
            loaded.allegati.get("urn:nir:stato:legge:1861-04-21;1"),
            Some(&true)
        );
    }

    #[test]
    fn load_from_path_missing_is_none() {
        assert!(AllegatiIndex::load_from_path(Path::new("/no/such/allegati.json")).is_none());
    }
}
