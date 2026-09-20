//! Allegato (annex) elenco parsing and role file formatting.
//!
//! Structured keep/repeal lists (taglia-leggi / salva-leggi style) are mostly
//! plain text without `urn:nir` hyperlinks. This module detects elenco-shaped
//! annexes, extracts rows, builds law-level URN candidates, and formats
//! per-allegato `.refs` sidecars (`urn \t keep|repeal|unknown [\t disposizioni]`).

use std::sync::LazyLock;

use regex::Regex;

use crate::api::text::{denomination_to_urn_form, html_to_plain_text, is_recoverable_urn};

static ELENCO_HINT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)elenco.{0,80}tipo.{0,40}(?:atto)?.{0,80}nu[mero\-\s]{2,20}.{0,40}data")
        .unwrap()
});

/// `Tipo atto … Numero/Nu-me-ro … Data` (112 Allegato A / 5/2012 / dual-index).
static ELENCO_TIPO_ATTO_HINT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)tipo.{0,20}atto.{0,80}nu[mero\-\s]{2,24}.{0,40}data").unwrap()
});

/// `Specie … Data … Numero` (taglia-leggi DL 200 Allegato 1).
static ELENCO_SPECIE_HINT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)specie.{0,40}data.{0,80}nu").unwrap());

static WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static WRAP_HYPHEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([A-Z])-\s+([A-Z])").unwrap());

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

/// Format C/E/F: `N TIPO NUM DD/MM/YYYY` (optional leading remap index is ignored
/// because `(?:^|\s)(\d+)\s+TIPO` binds the last index before the tipo).
static ROW_FULL_TIPO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|\s)(\d+)\s+([A-Z][A-Z0-9 .'\-]{0,60}?)\s+(\d+)\s+(\d{2}/\d{2}/\d{4})")
        .unwrap()
});

/// Format D: `N L|RD|RDL DD/MM/YYYY NUM`.
static ROW_SPECIE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|\s)(\d+)\s+([A-Z]{1,8}|[A-Z](?:\.[A-Z]+)+\.?)\s+(\d{2}/\d{2}/\d{4})\s+(\d+)\b",
    )
    .unwrap()
});

static VOCE_ESPUNTA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(\d+)\s+VOCE\s+(?:ESPUNTA|SOPPRESSA)").unwrap());

static DISPOSIZIONI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)((?:All\.\s*[A-Za-z0-9]+[:\s]+)?\b(?:artt?\.?|articoli?)\s*[\d\w\-–,;/\s]+)\s*$",
    )
    .unwrap()
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
    if ELENCO_HINT_RE.is_match(&plain)
        || ELENCO_TIPO_ATTO_HINT_RE.is_match(&plain)
        || ELENCO_SPECIE_HINT_RE.is_match(&plain)
    {
        return true;
    }
    // Truncated annexes may have lost the header; require several dated rows.
    elenco_row_hit_count(&plain) >= 3
}

fn elenco_row_hit_count(plain: &str) -> usize {
    let double = ROW_DOUBLE_DASH_RE.find_iter(plain).count();
    let single = ROW_SINGLE_DASH_RE.find_iter(plain).count();
    let full = ROW_FULL_TIPO_RE.find_iter(plain).count();
    let specie = ROW_SPECIE_RE.find_iter(plain).count();
    double.max(single).max(full).max(specie)
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
    // DL 200 Allegato 1: column header is Specie/Data/Numero, no "abrogate".
    if !keep && ELENCO_SPECIE_HINT_RE.is_match(head) {
        return AllegatoRole::Repeal;
    }
    AllegatoRole::Unknown
}

/// Normalize allegato tipo labels onto `denomination_to_urn_form` keys.
fn normalize_tipo(tipo: &str) -> String {
    let t = tipo.trim().to_uppercase();
    let t = WRAP_HYPHEN_RE.replace_all(&t, "$1$2").into_owned();
    let t = t.replace(['_', '.'], " ");
    let t = WS_RE.replace_all(&t, " ").trim().to_string();
    if let Some(canon) = alias_tipo(&t) {
        return canon.to_string();
    }
    // Allegato tables often omit the hyphen in DECRETO-LEGGE / REGIO DECRETO-LEGGE.
    match t.as_str() {
        "REGIO DECRETO LEGGE" => "REGIO DECRETO-LEGGE".to_string(),
        "DECRETO LEGGE" => "DECRETO-LEGGE".to_string(),
        "DECRETO LEGGE LUOGOTENENZIALE" => "DECRETO-LEGGE LUOGOTENENZIALE".to_string(),
        other => other.to_string(),
    }
}

/// Specie / dotted-abbrev tokens → existing `denomination_to_urn_form` keys.
fn alias_tipo(t: &str) -> Option<&'static str> {
    match t {
        "L" => Some("LEGGE"),
        "LC" | "L C" => Some("LEGGE COSTITUZIONALE"),
        "RD" | "R D" => Some("REGIO DECRETO"),
        "RDL" | "R D L" => Some("REGIO DECRETO-LEGGE"),
        "RDLGS" | "R D LGS" => Some("REGIO DECRETO LEGISLATIVO"),
        "DL" | "D L" => Some("DECRETO-LEGGE"),
        "DLL" | "D L L" => Some("DECRETO-LEGGE LUOGOTENENZIALE"),
        "DPR" | "D P R" => Some("DECRETO DEL PRESIDENTE DELLA REPUBBLICA"),
        "DLGS" | "D LGS" => Some("DECRETO LEGISLATIVO"),
        "DM" | "D M" => Some("DECRETO MINISTERIALE"),
        "DPCM" | "D P C M" => Some("DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI"),
        _ => None,
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

    let grammar = select_row_grammar(&plain)?;
    ingest_rows(
        &plain,
        grammar,
        &mut numbered_indices,
        &mut rows,
        &mut seen_keys,
    );

    numbered_indices.sort_unstable();
    numbered_indices.dedup();

    if rows.is_empty() {
        return None;
    }

    Some(ParsedAllegato {
        role,
        rows,
        numbered_indices,
    })
}

#[derive(Clone, Copy)]
struct RowGrammar {
    re: &'static Regex,
    /// Capture indices: tipo, numero, date (1-based, group 1 is always the row index).
    tipo: usize,
    numero: usize,
    date: usize,
}

fn select_row_grammar(plain: &str) -> Option<RowGrammar> {
    let double = ROW_DOUBLE_DASH_RE.find_iter(plain).count();
    if double > 0 {
        return Some(RowGrammar {
            re: &ROW_DOUBLE_DASH_RE,
            tipo: 2,
            numero: 3,
            date: 4,
        });
    }
    let single = ROW_SINGLE_DASH_RE.find_iter(plain).count();
    if single > 0 {
        return Some(RowGrammar {
            re: &ROW_SINGLE_DASH_RE,
            tipo: 2,
            numero: 3,
            date: 4,
        });
    }
    let full = ROW_FULL_TIPO_RE.find_iter(plain).count();
    let specie = ROW_SPECIE_RE.find_iter(plain).count();
    if full >= specie && full > 0 {
        return Some(RowGrammar {
            re: &ROW_FULL_TIPO_RE,
            tipo: 2,
            numero: 3,
            date: 4,
        });
    }
    if specie > 0 {
        return Some(RowGrammar {
            re: &ROW_SPECIE_RE,
            tipo: 2,
            numero: 4,
            date: 3,
        });
    }
    None
}

fn ingest_rows(
    plain: &str,
    grammar: RowGrammar,
    numbered_indices: &mut Vec<u32>,
    rows: &mut Vec<AllegatoRow>,
    seen_keys: &mut std::collections::HashSet<String>,
) {
    let matches: Vec<_> = grammar.re.captures_iter(plain).collect();
    for (i, caps) in matches.iter().enumerate() {
        let idx: u32 = caps[1].parse().unwrap_or(0);
        if idx > 0 {
            numbered_indices.push(idx);
        }
        let tipo = caps
            .get(grammar.tipo)
            .map(|m| m.as_str().trim())
            .unwrap_or("");
        if tipo.is_empty() || tipo.eq_ignore_ascii_case("VOCE") {
            continue;
        }
        let numero = caps
            .get(grammar.numero)
            .map(|m| m.as_str().trim())
            .unwrap_or("");
        let date = caps
            .get(grammar.date)
            .map(|m| m.as_str().trim())
            .unwrap_or("");
        if numero.is_empty() || date.is_empty() {
            continue;
        }

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
}

/// Format a `.refs` sidecar body for one allegato.
///
/// Lines are `urn_or_key \t kind [\t disposizioni]`.
/// `kind` is the allegato role: `repeal` (A deletes B), `keep` (A preserves B),
/// or `unknown`. Multivigenza *updates* stay in `.modifiedby`, not here.
pub fn format_allegato_refs(parsed: &ParsedAllegato) -> String {
    let kind = parsed.role.as_str();
    let mut out = format!("# role={kind}\n");
    for row in &parsed.rows {
        out.push_str(&row.urn_or_key);
        out.push('\t');
        out.push_str(kind);
        match &row.disposizioni {
            Some(d) if !d.is_empty() => {
                out.push('\t');
                out.push_str(d);
            }
            _ => {}
        }
        out.push('\n');
    }
    out
}

/// Collect recoverable URNs from parsed elenco rows (for relationship fetch).
pub fn elenco_urns(parsed: &ParsedAllegato) -> Vec<String> {
    parsed.rows.iter().filter_map(|r| r.urn.clone()).collect()
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

    const FIXTURE_CONVERSION: &str = r#"Allegato
MODIFICAZIONI APPORTATE IN SEDE DI CONVERSIONE AL DECRETO-LEGGE
Art. 1. Al comma 1 le parole 1 gennaio 2009 sono sostituite.
"#;

    /// Format C — DL 112/2008 Allegato A.
    const FIXTURE_112_ALL3: &str = r#"Allegato A

 Disposizioni abrogate ex articolo 24

 n Tipo atto Nu- me- ro Data Titolo

 1 LEGGE 1636 24/01/1864 AFFRANCAMENTO DEI CANONI ENFITEUTICI
 2 LEGGE 2359 25/06/1865 ESPROPRIAZIONI PER CAUSA DI UTILITÀ PUBBLICA
 3 LEGGE 2604 15/11/1865 AUTORIZZA LA PROMULGAZIONE
 4 REGIO DECRETO 2598 26/11/1865 L'APPROVAZIONE E PUBBLICAZIONE DEL CODICE
 5 LEGGE 2933 17/05/1866 ISTITUZIONE O CAMBIAMENTO
"#;

    /// Format D — DL 200/2008 Allegato 1.
    const FIXTURE_200_ALL1: &str = r#"Allegato 1

 (3)

 N. Specie Data Nu- me- ro Titolo

 1 L 21/04/1861 1 LEGGE 21 APRILE 1861, N. 1. - CHE STABILISCE LA FORMOLA
 2 L 25/04/1861 6 LEGGE 25 APRILE 1861, N. 6. - COLLA QUALE SONO APPLICATE
 3 L 05/05/1861 7 LEGGE 5 MAGGIO 1861, N. 7. - PER L'INSTITUZIONE
 4 L 19/05/1861 25 LEGGE 19 MAGGIO 1861, N. 25. - CHE PROROGA
 5 L 19/05/1861 26 LEGGE 19 MAGGIO 1861, N. 26. - PER LA RIAMMISSIONE
 8 VOCE SOPPRESSA DALLA L. 8 GIUGNO 2009, N. 69
"#;

    /// Format E — DL 5/2012 Allegato 1.
    const FIXTURE_5_2012: &str = r#"Tabella A

 (( (articolo 62, comma 1)

 Tipo atto Numero Data Titolo Disposizioni abrogate

 1 R.D. 126 03/01/1926 APPROVAZIONE DEL REGOLAMENTO ORGANICO articolo 4
 2 L. 833 03/08/1961 STATO GIURIDICO DEI VICEBRIGADIERI commi primo, secondo e terzo dell'articolo 7
 3 D.P.R. 63 14/01/1970 MODIFICAZIONI AL D.P.R. 29 DICEMBRE 1964 intero testo
"#;

    /// Format F — dual index then full tipo (DL 200 Allegato 2).
    const FIXTURE_200_ALL2: &str = r#"Allegato 2

 Nume- razio- ne ex d.l. 112/08 Nuova nume- ra- zione Tipo atto Nu- me- ro Data Titolo Note

 90 1 LEGGE 403 13/06/1907 IMPIANTO DI VIE FUNICOLARI AEREE
 181 2 REGIO DECRETO 1876 20/08/1923 NORME PER I MILITARI
"#;

    #[test]
    fn detects_elenco_shape() {
        assert!(is_elenco_shaped(FIXTURE_179_ALL1));
        assert!(is_elenco_shaped(FIXTURE_179_ALL2));
        assert!(is_elenco_shaped(FIXTURE_212));
        assert!(is_elenco_shaped(FIXTURE_112_ALL3));
        assert!(is_elenco_shaped(FIXTURE_200_ALL1));
        assert!(is_elenco_shaped(FIXTURE_5_2012));
        assert!(is_elenco_shaped(FIXTURE_200_ALL2));
        assert!(!is_elenco_shaped(FIXTURE_NON_ELENCO));
        assert!(!is_elenco_shaped(FIXTURE_CONVERSION));
    }

    #[test]
    fn classifies_roles() {
        assert_eq!(classify_allegato_role(FIXTURE_179_ALL1), AllegatoRole::Keep);
        assert_eq!(classify_allegato_role(FIXTURE_179_ALL2), AllegatoRole::Keep);
        assert_eq!(classify_allegato_role(FIXTURE_212), AllegatoRole::Repeal);
        assert_eq!(
            classify_allegato_role(FIXTURE_112_ALL3),
            AllegatoRole::Repeal
        );
        assert_eq!(
            classify_allegato_role(FIXTURE_200_ALL1),
            AllegatoRole::Repeal
        );
        assert_eq!(classify_allegato_role(FIXTURE_5_2012), AllegatoRole::Repeal);
    }

    fn urns_of(p: &ParsedAllegato) -> Vec<&str> {
        p.rows.iter().filter_map(|r| r.urn.as_deref()).collect()
    }

    #[test]
    fn parses_179_all1_single_dash() {
        let p = parse_elenco_allegato(FIXTURE_179_ALL1).expect("elenco");
        assert_eq!(p.role, AllegatoRole::Keep);
        assert!(p.rows.len() >= 5, "got {} rows", p.rows.len());
        assert!(
            p.numbered_indices.contains(&41),
            "voce espunta index tracked"
        );
        let urns = urns_of(&p);
        for u in [
            "urn:nir:stato:legge:1865-03-20;2248",
            "urn:nir:stato:legge:1865-04-27;2255",
            "urn:nir:stato:legge:1866-06-28;3050",
            "urn:nir:stato:regio.decreto:1866-07-07;3036",
        ] {
            assert!(urns.contains(&u), "missing {u} in {urns:?}");
        }
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
        let urns = urns_of(&p);
        for u in [
            "urn:nir:stato:legge:1861-07-25;106",
            "urn:nir:stato:legge:1862-02-20;1009",
        ] {
            assert!(urns.contains(&u), "missing {u}");
        }
        assert_eq!(
            p.rows[0].urn.as_deref(),
            Some("urn:nir:stato:legge:1861-07-25;106")
        );
        assert_eq!(p.rows[2].disposizioni.as_deref(), Some("artt. 1,2"));
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
        assert!(parse_elenco_allegato(FIXTURE_CONVERSION).is_none());
    }

    #[test]
    fn parses_format_c_112() {
        let p = parse_elenco_allegato(FIXTURE_112_ALL3).expect("elenco");
        assert_eq!(p.role, AllegatoRole::Repeal);
        assert_eq!(
            urns_of(&p),
            vec![
                "urn:nir:stato:legge:1864-01-24;1636",
                "urn:nir:stato:legge:1865-06-25;2359",
                "urn:nir:stato:legge:1865-11-15;2604",
                "urn:nir:stato:regio.decreto:1865-11-26;2598",
                "urn:nir:stato:legge:1866-05-17;2933",
            ]
        );
    }

    #[test]
    fn parses_format_d_200() {
        let p = parse_elenco_allegato(FIXTURE_200_ALL1).expect("elenco");
        assert_eq!(p.role, AllegatoRole::Repeal);
        assert!(p.numbered_indices.contains(&8), "voce soppressa tracked");
        assert_eq!(
            urns_of(&p),
            vec![
                "urn:nir:stato:legge:1861-04-21;1",
                "urn:nir:stato:legge:1861-04-25;6",
                "urn:nir:stato:legge:1861-05-05;7",
                "urn:nir:stato:legge:1861-05-19;25",
                "urn:nir:stato:legge:1861-05-19;26",
            ]
        );
    }

    #[test]
    fn parses_format_e_dotted_abbrev() {
        let p = parse_elenco_allegato(FIXTURE_5_2012).expect("elenco");
        assert_eq!(p.role, AllegatoRole::Repeal);
        // D.P.R. maps onto the existing denomination key (not the dotted full phrase).
        assert_eq!(
            urns_of(&p),
            vec![
                "urn:nir:stato:regio.decreto:1926-01-03;126",
                "urn:nir:stato:legge:1961-08-03;833",
                "urn:nir:stato:decreto.presidente.repubblica:1970-01-14;63",
            ]
        );
        assert!(
            p.rows[0]
                .disposizioni
                .as_deref()
                .is_some_and(|d| d.to_lowercase().contains("art")),
            "disposizioni={:?}",
            p.rows[0].disposizioni
        );
    }

    #[test]
    fn parses_format_f_dual_index() {
        let p = parse_elenco_allegato(FIXTURE_200_ALL2).expect("elenco");
        assert_eq!(
            urns_of(&p),
            vec![
                "urn:nir:stato:legge:1907-06-13;403",
                "urn:nir:stato:regio.decreto:1923-08-20;1876",
            ]
        );
    }

    fn history_rs_file(name: &str) -> Option<String> {
        let output = std::process::Command::new("git")
            .args(["show", &format!("history-rs:{name}")])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok()
    }

    #[test]
    fn history_rs_format_c_d_e_first_rows() {
        let Some(c) = history_rs_file("decreto-legge-112-del-25-06-2008.allegato-3.txt") else {
            return;
        };
        let p = parse_elenco_allegato(&c).expect("112 all3");
        assert_eq!(p.role, AllegatoRole::Repeal);
        assert_eq!(
            p.rows[0].urn.as_deref(),
            Some("urn:nir:stato:legge:1864-01-24;1636")
        );
        assert!(p.rows.len() >= 5);

        let Some(d) = history_rs_file("decreto-legge-200-del-22-12-2008.allegato-1.txt") else {
            return;
        };
        let p = parse_elenco_allegato(&d).expect("200 all1");
        assert_eq!(p.role, AllegatoRole::Repeal);
        assert_eq!(
            p.rows[0].urn.as_deref(),
            Some("urn:nir:stato:legge:1861-04-21;1")
        );

        let Some(e) = history_rs_file("decreto-legge-5-del-09-02-2012.allegato-1.txt") else {
            return;
        };
        let p = parse_elenco_allegato(&e).expect("5/2012");
        assert_eq!(p.role, AllegatoRole::Repeal);
        assert_eq!(
            p.rows[0].urn.as_deref(),
            Some("urn:nir:stato:regio.decreto:1926-01-03;126")
        );

        let Some(a212) = history_rs_file("decreto-legislativo-212-del-13-12-2010.allegato-1.txt")
        else {
            return;
        };
        let p = parse_elenco_allegato(&a212).expect("212");
        assert_eq!(p.role, AllegatoRole::Repeal);
        assert!(p.rows.len() > 100, "212 rows {}", p.rows.len());
    }

    #[test]
    fn write_refs_sidecars_if_env() {
        let Ok(dir) = std::env::var("WRITE_REFS_DIR") else {
            return;
        };
        let jobs = [
            "decreto-legge-112-del-25-06-2008.allegato-3.txt",
            "decreto-legge-200-del-22-12-2008.allegato-1.txt",
            "decreto-legge-200-del-22-12-2008.allegato-2.txt",
            "decreto-legge-5-del-09-02-2012.allegato-1.txt",
        ];
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        for src in jobs {
            let text = history_rs_file(src).expect(src);
            let p = parse_elenco_allegato(&text).unwrap_or_else(|| panic!("{src} not elenco"));
            let dst = src.replace(".txt", ".refs");
            std::fs::write(dir.join(&dst), format_allegato_refs(&p)).unwrap();
            eprintln!("wrote {dst} rows={} role={}", p.rows.len(), p.role.as_str());
        }
    }

    #[test]
    fn history_rs_t8_overlap() {
        let Some(t200) = history_rs_file("decreto-legge-200-del-22-12-2008.allegato-1.txt") else {
            return;
        };
        let Some(t179) = history_rs_file("decreto-legislativo-179-del-01-12-2009.allegato-2.txt")
        else {
            return;
        };
        let Some(t112) = history_rs_file("decreto-legge-112-del-25-06-2008.allegato-3.txt") else {
            return;
        };
        let s200: std::collections::HashSet<String> = parse_elenco_allegato(&t200)
            .expect("200")
            .rows
            .into_iter()
            .filter_map(|r| r.urn)
            .collect();
        let s179: std::collections::HashSet<String> = parse_elenco_allegato(&t179)
            .expect("179-2")
            .rows
            .into_iter()
            .filter_map(|r| r.urn)
            .collect();
        let s112: std::collections::HashSet<String> = parse_elenco_allegato(&t112)
            .expect("112")
            .rows
            .into_iter()
            .filter_map(|r| r.urn)
            .collect();
        let inter_200: usize = s200.intersection(&s179).count();
        let inter_112: usize = s112.intersection(&s179).count();
        eprintln!(
            "T8 |S200|={} |S179_2|={} |S112|={} |200∩179_2|={} |112∩179_2|={}",
            s200.len(),
            s179.len(),
            s112.len(),
            inter_200,
            inter_112
        );
        // On the truncated OpenData snapshot (200 stops ~1868, ~533 rows) the
        // rescue overlap lives mostly in later pages the API does not return.
        // Parser URNs still share a space (intersection ≥ 1, not 0). 112 is
        // a different list: intersection with 179-2 stays near zero.
        assert!(
            inter_200 >= 1,
            "200 allegato-1 ∩ 179 allegato-2 should not be empty, got {inter_200}"
        );
        assert!(
            inter_112 <= 5,
            "112∩179_2 should stay small, got {inter_112}"
        );
        assert!(
            s200.len() > 400 && s179.len() > 400 && s112.len() > 300,
            "expected substantial parsed sets"
        );
    }

    #[test]
    fn history_rs_179_refs_gold_prefix() {
        let Some(refs) = history_rs_file("decreto-legislativo-179-del-01-12-2009.allegato-1.refs")
        else {
            return;
        };
        assert!(refs.starts_with("# role=keep\n"));
        for u in [
            "urn:nir:stato:legge:1865-03-20;2248",
            "urn:nir:stato:legge:1865-04-27;2255",
            "urn:nir:stato:legge:1866-06-28;3050",
            "urn:nir:stato:regio.decreto:1866-07-07;3036",
            "urn:nir:stato:legge:1868-08-30;4613",
        ] {
            assert!(refs.contains(u), "gold refs missing {u}");
        }
        let Some(refs2) = history_rs_file("decreto-legislativo-179-del-01-12-2009.allegato-2.refs")
        else {
            return;
        };
        assert!(refs2.starts_with("# role=keep\n"));
        for u in [
            "urn:nir:stato:legge:1861-07-25;106",
            "urn:nir:stato:legge:1862-02-20;1009",
            "urn:nir:stato:legge:1862-04-21;1010",
            "urn:nir:stato:legge:1862-12-14;1029",
            "urn:nir:stato:legge:1864-12-11;2048",
        ] {
            assert!(refs2.contains(u), "gold refs2 missing {u}");
        }
    }

    #[test]
    fn format_refs_has_role_header() {
        let p = parse_elenco_allegato(FIXTURE_212).unwrap();
        let s = format_allegato_refs(&p);
        assert!(s.starts_with("# role=repeal\n"));
        assert!(s.contains("urn:nir:stato:regio.decreto:1861-04-28;13\trepeal\n"));
    }

    #[test]
    fn format_refs_marks_keep_and_disposizioni() {
        let p = parse_elenco_allegato(FIXTURE_179_ALL2).unwrap();
        let s = format_allegato_refs(&p);
        assert!(s.starts_with("# role=keep\n"));
        assert!(s.contains("urn:nir:stato:legge:1861-07-25;106\tkeep\n"));
        assert!(s.contains("urn:nir:stato:legge:1867-08-15;3848\tkeep\tartt. 1,2\n"));
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
        let numbered_data = p.numbered_indices.iter().filter(|&&i| i != 41).count();
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
