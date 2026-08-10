//! Allegato (annex) elenco parsing and role file formatting.
//!
//! Structured keep/repeal lists (taglia-leggi / salva-leggi style) are mostly
//! plain text without `urn:nir` hyperlinks. This module detects elenco-shaped
//! annexes, extracts rows, builds law-level URN candidates, and formats
//! per-allegato `.refs` sidecars.

use std::sync::LazyLock;

use regex::Regex;

use crate::api::text::{denomination_to_urn_form, html_to_plain_text, is_recoverable_urn};

static ELENCO_HINT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)elenco.{0,80}tipo.{0,40}(?:atto)?.{0,40}numero.{0,40}data",
    )
    .unwrap()
});

/// `N - TIPO - NUM - DD/MM/YYYY` (salva Allegato 1 style).
static ROW_SINGLE_DASH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|\s)(\d+)\s+-\s+([A-Z][A-Z0-9 \.\-]{1,60}?)\s+-\s+(\d+)\s+-\s+(\d{2}/\d{2}/\d{4})",
    )
    .unwrap()
});

/// `N -- TIPO -- NUM -- DD/MM/YYYY` (salva Allegato 2 style).
static ROW_DOUBLE_DASH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|\s)(\d+)\s+--\s+([A-Z][A-Z0-9 \.\-]{1,60}?)\s+--\s+(\d+)\s+--\s+(\d{2}/\d{2}/\d{4})",
    )
    .unwrap()
});

static VOCE_ESPUNTA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(\d+)\s+VOCE\s+ESPUNTA").unwrap());

static DISPOSIZIONI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)((?:All\.\s*[A-Za-z0-9]+[:\s]+)?artt?\.?\s*[\d\w\-–,;/\s]+)\s*$").unwrap()
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllegatoRole {
    Keep,
    Repeal,
    Unknown,
}

impl AllegatoRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "keep",
            Self::Repeal => "repeal",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllegatoRow {
    /// Law-level URN when buildable; otherwise `TIPO|NUMERO|DD/MM/YYYY`.
    pub urn_or_key: String,
    /// Recoverable URN suitable for relationship fetch, if any.
    pub urn: Option<String>,
    /// Raw “singole disposizioni” fragment when present.
    pub disposizioni: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAllegato {
    pub role: AllegatoRole,
    pub rows: Vec<AllegatoRow>,
    /// Numbered elenco indices seen (including VOCE ESPUNTA), for recall metrics.
    pub numbered_indices: Vec<u32>,
}

/// True when annex plaintext looks like an act elenco (Tipo / Numero / Data).
pub fn is_elenco_shaped(html_or_plain: &str) -> bool {
    let plain = if html_or_plain.contains('<') {
        html_to_plain_text(html_or_plain)
    } else {
        html_or_plain.to_string()
    };
    ELENCO_HINT_RE.is_match(&plain)
}

pub fn classify_allegato_role(html_or_plain: &str) -> AllegatoRole {
    let plain = if html_or_plain.contains('<') {
        html_to_plain_text(html_or_plain)
    } else {
        html_or_plain.to_string()
    };
    let lower = plain.to_lowercase();
    // Check the header region (first ~500 chars) preferentially.
    let head = if lower.len() > 500 {
        &lower[..500]
    } else {
        &lower
    };

    let keep_hints = [
        "salvati",
        "salva",
        "permanenza in vigore",
        "restano in vigore",
        "permangono in vigore",
        "indispensabile la permanenza",
    ];
    let repeal_hints = [
        "abrogate",
        "abrogati",
        "abrogazioni",
        "sono o restano abrogate",
        "disposizione abrogate",
        "disposizioni legislative elencate",
    ];

    let keep = keep_hints.iter().any(|h| head.contains(h));
    let repeal = repeal_hints.iter().any(|h| head.contains(h));

    // Taglia lists often say "abrogate" without "salvati".
    if repeal && !keep {
        return AllegatoRole::Repeal;
    }
    if keep {
        return AllegatoRole::Keep;
    }
    if repeal {
        return AllegatoRole::Repeal;
    }
    AllegatoRole::Unknown
}

/// Normalize allegato tipo labels onto `denomination_to_urn_form` keys.
fn normalize_tipo(tipo: &str) -> String {
    let t = tipo
        .trim()
        .to_uppercase()
        .replace(['_', '.'], " ");
    let t = Regex::new(r"\s+")
        .unwrap()
        .replace_all(&t, " ")
        .to_string();
    // Allegato tables often omit the hyphen in DECRETO-LEGGE / REGIO DECRETO-LEGGE.
    match t.as_str() {
        "REGIO DECRETO LEGGE" => "REGIO DECRETO-LEGGE".to_string(),
        "DECRETO LEGGE" => "DECRETO-LEGGE".to_string(),
        "DECRETO LEGGE LUOGOTENENZIALE" => "DECRETO-LEGGE LUOGOTENENZIALE".to_string(),
        other => other.to_string(),
    }
}

fn dmy_to_iso(dmy: &str) -> Option<String> {
    let parts: Vec<&str> = dmy.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    let (dd, mm, yyyy) = (parts[0], parts[1], parts[2]);
    if yyyy.len() != 4 || dd.len() != 2 || mm.len() != 2 {
        return None;
    }
    Some(format!("{yyyy}-{mm}-{dd}"))
}

/// Build `urn:nir:stato:{denom}:{iso};{num}` from elenco fields.
pub fn build_urn_from_elenco_row(tipo: &str, numero: &str, date_dmy: &str) -> Option<String> {
    let iso = dmy_to_iso(date_dmy)?;
    let denom = denomination_to_urn_form(&normalize_tipo(tipo));
    if denom.is_empty() {
        return None;
    }
    let urn = format!("urn:nir:stato:{denom}:{iso};{numero}");
    Some(urn.to_lowercase())
}

fn raw_key(tipo: &str, numero: &str, date_dmy: &str) -> String {
    format!("{}|{numero}|{date_dmy}", normalize_tipo(tipo))
}

fn extract_disposizioni(remainder: &str) -> Option<String> {
    let rem = remainder.trim();
    if rem.is_empty() {
        return None;
    }
    // Prefer an explicit artt./All. fragment near the end.
    if let Some(caps) = DISPOSIZIONI_RE.captures(rem) {
        let frag = caps.get(1)?.as_str().trim();
        if frag.len() >= 3 {
            return Some(frag.to_string());
        }
    }
    None
}

/// Parse an elenco-shaped allegato. Returns `None` when the annex is not an elenco.
pub fn parse_elenco_allegato(html_or_plain: &str) -> Option<ParsedAllegato> {
    if !is_elenco_shaped(html_or_plain) {
        return None;
    }
    let plain = if html_or_plain.contains('<') {
        html_to_plain_text(html_or_plain)
    } else {
        html_or_plain.to_string()
    };

    let role = classify_allegato_role(&plain);
    let mut numbered_indices: Vec<u32> = Vec::new();
    let mut rows: Vec<AllegatoRow> = Vec::new();
    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    for caps in VOCE_ESPUNTA_RE.captures_iter(&plain) {
        if let Ok(n) = caps[1].parse::<u32>() {
            numbered_indices.push(n);
        }
    }

    // Prefer double-dash matches when present (avoids partial single-dash hits).
    let double_count = ROW_DOUBLE_DASH_RE.find_iter(&plain).count();
    let use_double = double_count > 0;
    let row_re: &Regex = if use_double {
        &ROW_DOUBLE_DASH_RE
    } else {
        &ROW_SINGLE_DASH_RE
    };

    let matches: Vec<_> = row_re.captures_iter(&plain).collect();
    for (i, caps) in matches.iter().enumerate() {
        let idx: u32 = caps[1].parse().unwrap_or(0);
        if idx > 0 {
            numbered_indices.push(idx);
        }
        let tipo = caps[2].trim();
        let numero = caps[3].trim();
        let date = caps[4].trim();

        let end = caps.get(0).map(|m| m.end()).unwrap_or(0);
        let next_start = matches
            .get(i + 1)
            .and_then(|c| c.get(0).map(|m| m.start()))
            .unwrap_or(plain.len());
        let remainder = plain.get(end..next_start).unwrap_or("");
        let disposizioni = extract_disposizioni(remainder);

        let built = build_urn_from_elenco_row(tipo, numero, date);
        let key = raw_key(tipo, numero, date);
        let urn_or_key = built.clone().unwrap_or_else(|| key.clone());
        if !seen_keys.insert(urn_or_key.clone()) {
            continue;
        }
        let urn = built.filter(|u| is_recoverable_urn(u));
        rows.push(AllegatoRow {
            urn_or_key,
            urn,
            disposizioni,
        });
    }

    numbered_indices.sort_unstable();
    numbered_indices.dedup();

    Some(ParsedAllegato {
        role,
        rows,
        numbered_indices,
    })
}

/// Format a `.refs` sidecar body for one allegato.
pub fn format_allegato_refs(parsed: &ParsedAllegato) -> String {
    let mut out = format!("# role={}\n", parsed.role.as_str());
    for row in &parsed.rows {
        match &row.disposizioni {
            Some(d) if !d.is_empty() => {
                out.push_str(&row.urn_or_key);
                out.push('\t');
                out.push_str(d);
                out.push('\n');
            }
            _ => {
                out.push_str(&row.urn_or_key);
                out.push('\n');
            }
        }
    }
    out
}

/// Collect recoverable URNs from parsed elenco rows (for relationship fetch).
pub fn elenco_urns(parsed: &ParsedAllegato) -> Vec<String> {
    parsed
        .rows
        .iter()
        .filter_map(|r| r.urn.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    const FIXTURE_179_ALL1: &str = r#"<div class="bodyTesto"><span class="attachment-just-text">Allegato 1 - Atti normativi salvati pubblicati anteriormente al 1° gennaio 1970
=====================================================================
Elenco - Tipo Atto - Numero - Data Titolo Amministrazione Singole disposizioni che restano in vigore
=====================================================================
1 - LEGGE - 2248 - 20/03/1865 LEGGE PER L'UNIFICAZIONE AMMINISTRATIVA DEL REGNO D'ITALIA (ALLEGATO E, LEGGE SUL CONTENZIOSO AMMINISTRATIVO; ALLEGATO F, LEGGE SUI LAVORI PUBBLICI). Atto di carattere generale All. E: artt. 1, 2,3,4,5,6,7,8,9,10,11,12,14,15,16; All. F: artt. da 1 a 131
2 - LEGGE - 2255 - 27/04/1865 PER L'AMPLIAZIONE DEL TERRITORIO DELLA CITTÀ DI FIRENZE Atto di carattere generale
3 - LEGGE - 3050 - 28/06/1866 CHE APPROVA LA DELIMITAZIONE Economia e finanze
4 - REGIO DECRETO - 3036 - 07/07/1866 PER LA SOPPRESSIONE DEGLI ORDINI Beni e attività culturali artt. 11,18,24
41 VOCE ESPUNTA DAL D.LGS. 13 DICEMBRE 2010, N. 213
42 - REGIO DECRETO - 310 - 25/06/1899 CHE APPROVA IL PASSAGGIO Difesa
5 - REGIO DECRETO LEGGE - 165 - 13/02/1927 NORME VARIE artt. 1, 2
</span></div>"#;

    const FIXTURE_179_ALL2: &str = r#"<div class="bodyTesto"><span class="attachment-just-text"> Allegato 2 - Atti salvati dall'elenco delle abrogazioni allegato al decreto legge 22 dicembre 2008 n. 200
=====================================================================
Elenco -- Tipo Atto -- Numero -- Data -- Titolo -- Amministrazione -- Singole disposizioni che restano in vigore
=====================================================================
1 -- LEGGE -- 106 -- 25/07/1861 -- COLLA QUALE IL TERRITORIO -- Interno-Comuni --
2 -- LEGGE -- 1009 -- 20/02/1862 -- CHE SOPPRIME I COMUNI -- Interno-Comuni --
6 -- LEGGE -- 3848 -- 15/08/1867 -- PER LA LIQUIDAZIONE DELL'ASSE ECCLESIASTICO. -- Beni e attività culturali -- artt. 1,2
</span></div>"#;

    const FIXTURE_212: &str = r#"<div class="bodyTesto"><span class="attachment-just-text">Allegato - Disposizioni abrogate
=====================================================================
Elenco - Tipo Atto - Numero - Data Titolo
=====================================================================
7 - REGIO DECRETO - 13 - 28/04/1861 NORME
18 - REGIO DECRETO - 11 - 05/05/1861 ALTRO
39 - REGIO DECRETO - 41 - 26/05/1861 ANCORA
1720 - REGIO DECRETO - 2106 - 18/12/1864 FINE
</span></div>"#;

    const FIXTURE_NON_ELENCO: &str = r#"<div class="bodyTesto"><span class="attachment-just-text">Allegato A - Tabella dei coefficienti
1 2 3
4 5 6
</span></div>"#;

    #[test]
    fn detects_elenco_shape() {
        assert!(is_elenco_shaped(FIXTURE_179_ALL1));
        assert!(is_elenco_shaped(FIXTURE_179_ALL2));
        assert!(is_elenco_shaped(FIXTURE_212));
        assert!(!is_elenco_shaped(FIXTURE_NON_ELENCO));
    }

    #[test]
    fn classifies_roles() {
        assert_eq!(classify_allegato_role(FIXTURE_179_ALL1), AllegatoRole::Keep);
        assert_eq!(classify_allegato_role(FIXTURE_179_ALL2), AllegatoRole::Keep);
        assert_eq!(classify_allegato_role(FIXTURE_212), AllegatoRole::Repeal);
    }

    #[test]
    fn parses_179_all1_single_dash() {
        let p = parse_elenco_allegato(FIXTURE_179_ALL1).expect("elenco");
        assert_eq!(p.role, AllegatoRole::Keep);
        assert!(p.rows.len() >= 5, "got {} rows", p.rows.len());
        assert!(p.numbered_indices.contains(&41), "voce espunta index tracked");
        let first = &p.rows[0];
        assert_eq!(
            first.urn.as_deref(),
            Some("urn:nir:stato:legge:1865-03-20;2248")
        );
        assert!(
            first
                .disposizioni
                .as_deref()
                .is_some_and(|d| d.to_lowercase().contains("art")),
            "disposizioni={:?}",
            first.disposizioni
        );
        // VOCE ESPUNTA must not produce a row
        assert!(p.rows.iter().all(|r| !r.urn_or_key.contains("ESPUNTA")));
    }

    #[test]
    fn parses_179_all2_double_dash() {
        let p = parse_elenco_allegato(FIXTURE_179_ALL2).expect("elenco");
        assert_eq!(p.role, AllegatoRole::Keep);
        assert_eq!(p.rows.len(), 3);
        assert_eq!(
            p.rows[0].urn.as_deref(),
            Some("urn:nir:stato:legge:1861-07-25;106")
        );
        assert_eq!(
            p.rows[2].disposizioni.as_deref(),
            Some("artt. 1,2")
        );
    }

    #[test]
    fn parses_212_repeal() {
        let p = parse_elenco_allegato(FIXTURE_212).expect("elenco");
        assert_eq!(p.role, AllegatoRole::Repeal);
        assert_eq!(p.rows.len(), 4);
        assert_eq!(
            p.rows[0].urn.as_deref(),
            Some("urn:nir:stato:regio.decreto:1861-04-28;13")
        );
    }

    #[test]
    fn non_elenco_returns_none() {
        assert!(parse_elenco_allegato(FIXTURE_NON_ELENCO).is_none());
    }

    #[test]
    fn format_refs_has_role_header() {
        let p = parse_elenco_allegato(FIXTURE_212).unwrap();
        let s = format_allegato_refs(&p);
        assert!(s.starts_with("# role=repeal\n"));
        assert!(s.contains("urn:nir:stato:regio.decreto:1861-04-28;13\n"));
    }

    #[test]
    fn regio_decreto_legge_maps() {
        let u = build_urn_from_elenco_row("REGIO DECRETO LEGGE", "165", "13/02/1927").unwrap();
        assert_eq!(u, "urn:nir:stato:regio.decreto.legge:1927-02-13;165");
    }

    #[test]
    fn recall_bar_on_fixture_rows() {
        let p = parse_elenco_allegato(FIXTURE_179_ALL1).unwrap();
        // 5 data rows + index 41 voce espunta in numbered_indices
        let data_rows = p.rows.len();
        let numbered_data = p
            .numbered_indices
            .iter()
            .filter(|&&i| i != 41)
            .count();
        let recall = data_rows as f64 / numbered_data.max(1) as f64;
        assert!(
            recall >= 0.9,
            "recall {recall} rows={} numbered_data={numbered_data}",
            data_rows
        );
    }

    #[test]
    fn fixtures_on_disk_parse() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let a1 = std::fs::read_to_string(root.join("dlg_179_allegato1.html")).unwrap();
        let a2 = std::fs::read_to_string(root.join("dlg_179_allegato2.html")).unwrap();
        let a212 = std::fs::read_to_string(root.join("dlg_212_allegato1.html")).unwrap();
        let p1 = parse_elenco_allegato(&a1).expect("179 all1");
        let p2 = parse_elenco_allegato(&a2).expect("179 all2");
        let p212 = parse_elenco_allegato(&a212).expect("212");
        assert_eq!(p1.role, AllegatoRole::Keep);
        assert_eq!(p2.role, AllegatoRole::Keep);
        assert_eq!(p212.role, AllegatoRole::Repeal);
        assert!(p1.rows.len() >= 5);
        assert_eq!(p2.rows.len(), 3);
        assert_eq!(p212.rows.len(), 4);
    }

    /// Live canary against Normattiva (Decision 12). Run with:
    /// `LIVE_CANARY=1 cargo test --bin italian-laws-history live_canary_elenco_recall -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "live Normattiva network"]
    async fn live_canary_elenco_recall() {
        if std::env::var("LIVE_CANARY").ok().as_deref() != Some("1") {
            eprintln!("skip: set LIVE_CANARY=1 to run");
            return;
        }
        async fn fetch(urn: &str) -> String {
            let url = "https://api.normattiva.it/t/normattiva.api/bff-opendata/v1/api/v1/atto/dettaglio-atto-urn";
            let client = reqwest::Client::new();
            let res = client
                .post(url)
                .json(&serde_json::json!({ "urn": urn }))
                .send()
                .await
                .expect("http");
            let v: serde_json::Value = res.json().await.expect("json");
            v["data"]["atto"]["articoloHtml"]
                .as_str()
                .or_else(|| v["data"]["atto"]["testoInVigore"].as_str())
                .unwrap_or("")
                .to_string()
        }

        fn recall_ratio(got_rows: usize, numbered: usize, voce: usize) -> f64 {
            let expected = numbered.saturating_sub(voce).max(1);
            got_rows as f64 / expected as f64
        }

        let cases = [
            (
                "179-all1",
                "urn:nir:stato:decreto.legislativo:2009-12-01;179:1~art1",
                AllegatoRole::Keep,
            ),
            (
                "179-all2",
                "urn:nir:stato:decreto.legislativo:2009-12-01;179:2~art1",
                AllegatoRole::Keep,
            ),
            (
                "212-all1",
                "urn:nir:stato:decreto.legislativo:2010-12-13;212:1~art1",
                AllegatoRole::Repeal,
            ),
        ];

        for (label, urn, want_role) in cases {
            let html = fetch(urn).await;
            assert!(!html.is_empty(), "{label}: empty html");
            let p = parse_elenco_allegato(&html).unwrap_or_else(|| panic!("{label}: not elenco"));
            assert_eq!(p.role, want_role, "{label}: role");
            // Count VOCE ESPUNTA in plain text
            let plain = crate::api::text::html_to_plain_text(&html);
            let voce = Regex::new(r"(?i)\d+\s+VOCE\s+ESPUNTA")
                .unwrap()
                .find_iter(&plain)
                .count();
            let got = p.rows.len();
            let r = recall_ratio(got, p.numbered_indices.len(), voce);
            eprintln!(
                "{label}: role={} rows={got} numbered={} voce={voce} recall={r:.3}",
                p.role.as_str(),
                p.numbered_indices.len()
            );
            assert!(
                r >= 0.9,
                "{label}: recall {r:.3} below 0.9 (rows={got} expected≈{})",
                p.numbered_indices.len().saturating_sub(voce).max(1)
            );
            let refs = format_allegato_refs(&p);
            assert!(refs.starts_with(&format!("# role={}", want_role.as_str())));
            assert!(refs.lines().count() > 10, "{label}: too few refs lines");
        }
    }
}
