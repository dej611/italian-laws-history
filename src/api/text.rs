use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::types::{AttoDto, NormattivaAtto};

static URN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)urn:nir:[^\\s\"'<>]+").unwrap());
static URN_DATE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{4}-\d{2}-\d{2}").unwrap());

static TAG_BR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
static TAG_BLOCK_END_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</(?:p|div|li|tr|h[1-6])>").unwrap());
static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static ENTITY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));").unwrap());
static SPACES_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
static MULTI_NEWLINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
#[allow(dead_code)]
static FILENAME_SANITIZE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-zA-Z0-9._\-]").unwrap());
static FALLBACK_SANITIZE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-zA-Z0-9_\-]").unwrap());
#[allow(dead_code)]
static URN_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^urn:nir:").unwrap());
static SPACE_DASH_RUN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s-]+").unwrap());
static WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

static NAMED_ENTITIES: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    HashMap::from([
        ("amp", "&"),
        ("lt", "<"),
        ("gt", ">"),
        ("quot", "\""),
        ("apos", "'"),
        ("nbsp", " "),
        ("agrave", "à"),
        ("egrave", "è"),
        ("igrave", "ì"),
        ("ograve", "ò"),
        ("ugrave", "ù"),
    ])
});

static DENOMINATION_URN_MAP: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    HashMap::from([
        ("COSTITUZIONE", "costituzione"),
        ("DECRETO", "decreto"),
        ("DECRETO DEL CAPO DEL GOVERNO", "decreto.capo.governo"),
        ("DECRETO DEL CAPO PROVVISORIO DELLO STATO", "decreto.capo.provvisorio.stato"),
        ("DECRETO DEL DUCE", "decreto.duce"),
        ("DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI", "decreto.presidente.consiglio.ministri"),
        ("DECRETO DEL PRESIDENTE DELLA REPUBBLICA", "decreto.presidente.repubblica"),
        ("DECRETO LEGISLATIVO", "decreto.legislativo"),
        ("DECRETO LEGISLATIVO DEL CAPO PROVVISORIO DELLO STATO", "decreto.legislativo.capo.provvisorio.stato"),
        ("DECRETO LEGISLATIVO LUOGOTENENZIALE", "decreto.legislativo.luogotenenziale"),
        ("DECRETO LEGISLATIVO PRESIDENZIALE", "decreto.legislativo.presidenziale"),
        ("DECRETO LUOGOTENENZIALE", "decreto.luogotenenziale"),
        ("DECRETO MINISTERIALE", "decreto.ministeriale"),
        ("DECRETO PRESIDENZIALE", "decreto.presidenziale"),
        ("DECRETO REALE", "regio.decreto"),
        ("DECRETO-LEGGE", "decreto.legge"),
        ("DECRETO-LEGGE LUOGOTENENZIALE", "decreto.legge.luogotenenziale"),
        ("DELIBERAZIONE", "deliberazione"),
        ("LEGGE", "legge"),
        ("LEGGE COSTITUZIONALE", "legge.costituzionale"),
        ("ORDINANZA", "ordinanza"),
        ("REGIO DECRETO", "regio.decreto"),
        ("REGIO DECRETO-LEGGE", "regio.decreto.legge"),
        ("REGIO DECRETO LEGISLATIVO", "regio.decreto.legislativo"),
        ("REGOLAMENTO", "regolamento"),
    ])
});

pub fn urn_date(urn: &str) -> Option<String> {
    URN_DATE_RE.find(urn).map(|m| m.as_str().to_string())
}

/// Extract unique law-level URN references from HTML content.
/// Strips article-level fragments (after `~`) and deduplicates.
/// `before_date` filters URNs whose embedded date is strictly before that date
/// (URNs without a parseable date are kept conservatively).
pub fn extract_urns(html: &str, self_codice: Option<&str>, before_date: Option<&str>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let self_lc = self_codice.map(|s| s.to_lowercase());

    for m in URN_RE.find_iter(html) {
        let raw = m.as_str();
        let law_level = raw.split('~').next().unwrap_or(raw).to_lowercase();

        if let Some(self_lc) = &self_lc {
            if law_level.contains(self_lc) {
                continue;
            }
        }

        if let Some(before) = before_date {
            if let Some(d) = urn_date(&law_level) {
                if d.as_str() >= before {
                    continue;
                }
            }
        }

        if seen.insert(law_level.clone()) {
            out.push(law_level);
        }
    }

    out
}

#[allow(dead_code)]
pub fn urn_to_file_name(urn: &str) -> String {
    let stripped = URN_PREFIX_RE.replace(urn, "");
    let safe = FILENAME_SANITIZE_RE.replace_all(&stripped, "_");
    format!("{safe}.txt")
}

/// Build a Normattiva URN from act metadata. Returns None when required fields are missing.
pub fn build_act_urn(act: &NormattivaAtto) -> Option<String> {
    let denom_raw = act.denominazione_atto.as_deref()?.trim().to_uppercase();
    if denom_raw.is_empty() {
        return None;
    }

    let urn_denom = DENOMINATION_URN_MAP
        .get(denom_raw.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            SPACE_DASH_RUN_RE
                .replace_all(&denom_raw.to_lowercase(), ".")
                .to_string()
        });

    let year = act.anno_provvedimento.as_ref()?;
    let num = act.numero_provvedimento.as_ref()?;
    let month = act.mese_provvedimento.as_deref().unwrap_or("01");
    let day = act.giorno_provvedimento.as_deref().unwrap_or("01");
    let mm = pad2(month);
    let dd = pad2(day);

    Some(format!("urn:nir:stato:{urn_denom}:{year}-{mm}-{dd};{num}"))
}

fn pad2(s: &str) -> String {
    if s.len() >= 2 {
        s.to_string()
    } else {
        format!("{:0>2}", s)
    }
}

/// `{denomination}-{number}-del-{DD}-{MM}-{YYYY}.txt`, with an ID-derived fallback.
pub fn build_file_name(
    denomination: Option<&str>,
    number: Option<&str>,
    day: Option<&str>,
    month: Option<&str>,
    year: Option<&str>,
    fallback_id: &str,
) -> String {
    if denomination.is_none() && number.is_none() && day.is_none() {
        let safe = FALLBACK_SANITIZE_RE.replace_all(fallback_id, "_");
        return format!("{safe}.txt");
    }
    let prefix = denomination
        .map(|d| WS_RE.replace_all(&d.to_lowercase(), "-").to_string())
        .unwrap_or_else(|| "atto".to_string());
    let num = number.unwrap_or("sn");
    let dd = pad2(day.unwrap_or("00"));
    let mm = pad2(month.unwrap_or("00"));
    let yyyy = year.unwrap_or("0000");
    format!("{prefix}-{num}-del-{dd}-{mm}-{yyyy}.txt")
}

/// Convenience: build a filename from the AttoDto detail-endpoint shape.
pub fn atto_file_name(atto: &AttoDto, fallback_id: &str) -> String {
    let day = atto.giorno_provvedimento.map(|n| n.to_string());
    let month = atto.mese_provvedimento.map(|n| n.to_string());
    let year = atto.anno_provvedimento.map(|n| n.to_string());
    let num = atto.numero_provvedimento.map(|n| n.to_string());

    build_file_name(
        atto.tipo_provvedimento_descrizione.as_deref(),
        num.as_deref(),
        day.as_deref(),
        month.as_deref(),
        year.as_deref(),
        fallback_id,
    )
}

pub fn html_to_plain_text(html: &str) -> String {
    let mut text = TAG_BR_RE.replace_all(html, "\n").to_string();
    text = TAG_BLOCK_END_RE.replace_all(&text, "\n").to_string();
    text = TAG_RE.replace_all(&text, "").to_string();

    text = ENTITY_RE
        .replace_all(&text, |caps: &regex::Captures<'_>| {
            if let Some(dec) = caps.get(1) {
                if let Ok(n) = dec.as_str().parse::<u32>() {
                    if let Some(c) = char::from_u32(n) {
                        return c.to_string();
                    }
                }
            }
            if let Some(hex) = caps.get(2) {
                if let Ok(n) = u32::from_str_radix(hex.as_str(), 16) {
                    if let Some(c) = char::from_u32(n) {
                        return c.to_string();
                    }
                }
            }
            if let Some(name) = caps.get(3) {
                let key = name.as_str().to_lowercase();
                if let Some(rep) = NAMED_ENTITIES.get(key.as_str()) {
                    return (*rep).to_string();
                }
            }
            caps.get(0).unwrap().as_str().to_string()
        })
        .to_string();

    text = SPACES_RE.replace_all(&text, " ").to_string();
    text = MULTI_NEWLINE_RE.replace_all(&text, "\n\n").to_string();
    text.trim().to_string()
}

pub fn to_plain_text(atto: &AttoDto) -> (String, String) {
    let raw = atto
        .testo_in_vigore
        .clone()
        .or_else(|| atto.articolo_html.clone())
        .unwrap_or_default();
    let plain = if raw.is_empty() { String::new() } else { html_to_plain_text(&raw) };
    (raw, plain)
}

pub fn is_decreto_legge(act: &NormattivaAtto) -> bool {
    if act.tipo_provvedimento_codice.as_deref() == Some("PDL") {
        return true;
    }
    act.denominazione_atto
        .as_deref()
        .map(|d| d.to_uppercase().contains("DECRETO-LEGGE"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_law_level_urns_dedup() {
        let html = r#"see urn:nir:stato:legge:1900-01-15;42~art1 and urn:nir:stato:legge:1900-01-15;42~art2"#;
        assert_eq!(
            extract_urns(html, None, None),
            vec!["urn:nir:stato:legge:1900-01-15;42".to_string()]
        );
    }

    #[test]
    fn extracts_filters_by_self_codice() {
        let html = "urn:nir:stato:legge:1900-01-15;42 and urn:nir:stato:legge:1901-02-01;7";
        // self_codice matched as substring (lowercase), so the date pattern "1900-01-15" suffices
        let out = extract_urns(html, Some("1900-01-15"), None);
        assert_eq!(out, vec!["urn:nir:stato:legge:1901-02-01;7".to_string()]);
    }

    #[test]
    fn extracts_filters_by_date() {
        let html = "urn:nir:stato:legge:1900-01-15;42 urn:nir:stato:legge:2025-01-01;9";
        let out = extract_urns(html, None, Some("2000-01-01"));
        assert_eq!(out, vec!["urn:nir:stato:legge:1900-01-15;42".to_string()]);
    }

    #[test]
    fn html_strips_tags_and_entities() {
        // `</p>` → \n and `<br/>` → \n yields \n\n between segments.
        let s = html_to_plain_text("<p>caff&egrave; &amp; t&#232;</p><br/>fine");
        assert_eq!(s, "caffè & tè\n\nfine");
    }

    #[test]
    fn build_act_urn_round_trips() {
        let act = NormattivaAtto {
            denominazione_atto: Some("LEGGE".to_string()),
            anno_provvedimento: Some("2020".to_string()),
            mese_provvedimento: Some("1".to_string()),
            giorno_provvedimento: Some("5".to_string()),
            numero_provvedimento: Some("123".to_string()),
            ..Default::default()
        };
        assert_eq!(
            build_act_urn(&act),
            Some("urn:nir:stato:legge:2020-01-05;123".to_string())
        );
    }

    #[test]
    fn urn_to_file_name_strips_prefix_and_sanitises() {
        assert_eq!(
            urn_to_file_name("urn:nir:stato:legge:2020-01-15;123"),
            "stato_legge_2020-01-15_123.txt"
        );
    }

    #[test]
    fn detects_decreto_legge() {
        let mut act = NormattivaAtto {
            tipo_provvedimento_codice: Some("PDL".to_string()),
            ..Default::default()
        };
        assert!(is_decreto_legge(&act));
        act.tipo_provvedimento_codice = None;
        act.denominazione_atto = Some("DECRETO-LEGGE".to_string());
        assert!(is_decreto_legge(&act));
        act.denominazione_atto = Some("LEGGE".to_string());
        assert!(!is_decreto_legge(&act));
    }
}
