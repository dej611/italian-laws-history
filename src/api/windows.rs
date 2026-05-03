use anyhow::{anyhow, Result};
use chrono::{Datelike, NaiveDate, Utc};

/// Generates monthly `[from, to)` windows from `since_date` up to today (UTC),
/// where `to` is `from + 1 month` (clamped to today on the last iteration).
pub fn monthly_windows(since_date: &str) -> Result<Vec<(NaiveDate, NaiveDate)>> {
    let start = NaiveDate::parse_from_str(since_date, "%Y-%m-%d")
        .map_err(|e| anyhow!("invalid since-date {since_date}: {e}"))?;
    let now = Utc::now().date_naive();
    let mut out = Vec::new();
    let mut cursor = start;
    while cursor < now {
        let next = add_one_month(cursor);
        let window_end = if next < now { next } else { now };
        out.push((cursor, window_end));
        cursor = next;
    }
    Ok(out)
}

fn add_one_month(d: NaiveDate) -> NaiveDate {
    let (mut year, mut month) = (d.year(), d.month());
    month += 1;
    if month == 13 {
        month = 1;
        year += 1;
    }
    // Clamp day-of-month to month length (so 1900-01-31 + 1m = 1900-02-28).
    let day = d.day().min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).unwrap_or(d)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next_first = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1).unwrap()
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1).unwrap()
    };
    let this_first = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    next_first.signed_duration_since(this_first).num_days() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_month_rollover() {
        assert_eq!(add_one_month(NaiveDate::from_ymd_opt(2020, 1, 31).unwrap()),
                   NaiveDate::from_ymd_opt(2020, 2, 29).unwrap());
        assert_eq!(add_one_month(NaiveDate::from_ymd_opt(2020, 12, 15).unwrap()),
                   NaiveDate::from_ymd_opt(2021, 1, 15).unwrap());
    }

    #[test]
    fn produces_monotonic_windows() {
        let wins = monthly_windows("2020-01-15").unwrap();
        assert!(!wins.is_empty());
        for w in wins.windows(2) {
            assert!(w[0].0 < w[1].0);
            assert!(w[0].1 <= w[1].0);
        }
    }
}
