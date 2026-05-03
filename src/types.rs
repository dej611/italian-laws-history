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

/// Short namespace identifier for a branchable provisional act type.
///
/// Lifecycle reference (legal regime → modeling decision):
/// - `Dl`    — modern Decreto-Legge (post-1948, art. 77 Cost.): 60d, decadenza ex tunc.
/// - `Rdl`   — Regio decreto-legge:
///   - post-1926 (L. 100/1926, effective 1926-02-09): ~2y, decadenza ex nunc.
///   - pre-1926 ("catastrofali"): no automatic decadenza — branch waits indefinitely.
/// - `Dll`   — Decreto-legge luogotenenziale (WWI individual conversion + 1944–46
///   cohort awaiting L. 561/1956 sanatoria). `deadline_days = None`.
/// - `Dlcps` — Decreto legislativo del Capo provvisorio dello Stato (1946–47),
///   ratified en bloc by L. 561/1956. `deadline_days = None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BranchableShort {
    Dl,
    Rdl,
    Dll,
    Dlcps,
}

impl BranchableShort {
    /// Lowercase namespace fragment used in branch names (`dl`, `rdl`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            BranchableShort::Dl => "dl",
            BranchableShort::Rdl => "rdl",
            BranchableShort::Dll => "dll",
            BranchableShort::Dlcps => "dlcps",
        }
    }

    /// Uppercase short tag used in log lines and `Marcatore: <SHORT> ...` subjects.
    pub fn upper(self) -> &'static str {
        match self {
            BranchableShort::Dl => "DL",
            BranchableShort::Rdl => "RDL",
            BranchableShort::Dll => "DLL",
            BranchableShort::Dlcps => "DLCPS",
        }
    }

    /// Pretty Italian phrasing used in marker file content.
    pub fn pretty(self) -> &'static str {
        match self {
            BranchableShort::Dl => "Decreto-Legge",
            BranchableShort::Rdl => "Regio decreto-legge",
            BranchableShort::Dll => "Decreto-legge luogotenenziale",
            BranchableShort::Dlcps => "Decreto del Capo provvisorio dello Stato",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAct {
    pub codice_redazionale: String,
    pub branch_name: String,
    pub data_gu: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denominazione_atto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_provvedimento: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anno_provvedimento: Option<String>,
    /// Branch namespace short code. Defaults to `Dl` when loading checkpoints
    /// written before the multi-type rework.
    #[serde(default = "default_short")]
    pub short: BranchableShort,
    /// Days from publication after which the act lapses if not converted.
    /// `None` when the regime has no automatic decadenza (pre-1926 RDL,
    /// 1944–46 cohort awaiting L. 561/1956). Defaults to `Some(60)` when
    /// loading legacy checkpoints.
    #[serde(default = "default_deadline")]
    pub deadline_days: Option<u32>,
}

fn default_short() -> BranchableShort {
    BranchableShort::Dl
}
fn default_deadline() -> Option<u32> {
    Some(60)
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
    /// Generalised pool of provisional acts awaiting conversion / ratification / decadenza.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_acts: Option<HashMap<String, PendingAct>>,
    /// Migrated into `pending_acts` on load; retained for back-compat with old checkpoint files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_decreti_legge: Option<HashMap<String, PendingAct>>,
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
