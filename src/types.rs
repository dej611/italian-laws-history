use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct Config {
    pub api_base: String,
    pub api_token: String,
    pub output_repo: String,
    pub author_name: String,
    pub author_email: String,
    /// Read from env for parity with the TS port; unused by the binary today.
    #[allow(dead_code)]
    pub github_repo: Option<String>,
    pub batch_size: u32,
    pub concurrency: u32,
    pub min_time_ms: u64,
    pub max_retries: u32,
    pub cache_ttl_sec: u64,
    pub checkpoint_file: String,
}

/// Mirrors `RicercaResponseAtto` from the dati.normattiva.it OpenAPI spec.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormattivaAtto {
    pub codice_redazionale: String,
    #[serde(rename = "dataGU")]
    pub data_gu: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "numeroGU")]
    pub numero_gu: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub titolo_atto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denominazione_atto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_emanazione: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_ultima_modifica: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anno_provvedimento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mese_provvedimento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub giorno_provvedimento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_provvedimento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descrizione_atto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ultimi_atti_modificanti: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_supplemento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tipo_supplemento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "tipoSupplementoCode")]
    pub tipo_supplemento_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tipo_provvedimento_codice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classe_provvedimento: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDl {
    pub codice_redazionale: String,
    pub branch_name: String,
    pub data_gu: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denominazione_atto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_provvedimento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anno_provvedimento: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActVersionEntry {
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refs: Option<u32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    #[serde(default)]
    pub act_versions: HashMap<String, ActVersionEntry>,
    #[serde(default)]
    pub last_run: Option<String>,
    #[serde(default)]
    pub last_fully_scanned_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_decreti_legge: Option<HashMap<String, PendingDl>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttoDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub titolo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sotto_titolo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub articolo_html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub testo_in_vigore: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_pubblicazione_in_gazzetta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tipo_provvedimento_descrizione: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tipo_provvedimento_codice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anno_provvedimento: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mese_provvedimento: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub giorno_provvedimento: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_provvedimento: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "annoGU")]
    pub anno_gu: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "meseGU")]
    pub mese_gu: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "giornoGU")]
    pub giorno_gu: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "numeroGU")]
    pub numero_gu: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "tipoSupplementoCode")]
    pub tipo_supplemento_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_supplemento: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub articolo_data_inizio_vigenza: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub articolo_data_fine_vigenza: Option<String>,
}

#[allow(dead_code)] // `message` and `lista` are populated by serde for parity but unused.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DettaglioAttoData {
    #[serde(default)]
    pub atto: Option<AttoDto>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub lista: Option<Vec<AttoDto>>,
}

#[allow(dead_code)] // `code` parsed for parity; not consumed.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DettaglioAttoResponse {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub data: Option<DettaglioAttoData>,
}

#[allow(dead_code)] // facets parsed for parity with the TS port; only `lista_atti` and `numero_pagine` are consumed today.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RicercaResponse {
    #[serde(default)]
    pub lista_atti: Option<Vec<NormattivaAtto>>,
    #[serde(default)]
    pub numero_pagine: Option<u32>,
    #[serde(default)]
    pub numero_atti_trovati: Option<u32>,
    #[serde(default)]
    pub pagina_corrente: Option<u32>,
    #[serde(default)]
    pub numero_elementi_per_pagina: Option<u32>,
    #[serde(default)]
    pub message: Option<String>,
}

/// Lifecycle status used by `fetch_act_status` and DL reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActStatus {
    InForce,
    Updated,
    Abrogated,
}
