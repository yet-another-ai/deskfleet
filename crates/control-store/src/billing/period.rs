use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Utc};

/// Calendar months retain the original UTC day and time, even after a short month.
pub fn period_at(anchor_ms: i64, now_ms: i64) -> (i64, i64) {
    let anchor = DateTime::<Utc>::from_timestamp_millis(anchor_ms).unwrap_or_default();
    let now = DateTime::<Utc>::from_timestamp_millis(now_ms).unwrap_or(anchor);
    let months = (now.year() - anchor.year()) * 12 + now.month() as i32 - anchor.month() as i32;
    let mut offset = months.max(0);
    if month_boundary(anchor, offset) > now && offset > 0 {
        offset -= 1;
    }
    (
        month_boundary(anchor, offset).timestamp_millis(),
        month_boundary(anchor, offset + 1).timestamp_millis(),
    )
}

fn month_boundary(anchor: DateTime<Utc>, months: i32) -> DateTime<Utc> {
    let total = anchor.year() * 12 + anchor.month0() as i32 + months;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) as u32 + 1;
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    let last_day = next
        .and_then(|date| date.pred_opt())
        .map_or(28, |date| date.day());
    NaiveDate::from_ymd_opt(year, month, anchor.day().min(last_day))
        .map(|date| Utc.from_utc_datetime(&date.and_time(anchor.time())))
        .unwrap_or(anchor)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ms(value: &str) -> i64 {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis()
    }
    #[test]
    fn short_month_does_not_move_anchor() {
        let anchor = ms("2027-01-31T13:14:15Z");
        assert_eq!(
            period_at(anchor, ms("2027-02-28T13:14:15Z")),
            (ms("2027-02-28T13:14:15Z"), ms("2027-03-31T13:14:15Z"))
        );
        assert_eq!(
            period_at(anchor, ms("2027-03-31T13:14:14Z")),
            (ms("2027-02-28T13:14:15Z"), ms("2027-03-31T13:14:15Z"))
        );
        assert_eq!(
            period_at(anchor, ms("2027-03-31T13:14:15Z")),
            (ms("2027-03-31T13:14:15Z"), ms("2027-04-30T13:14:15Z"))
        );
    }
    #[test]
    fn leap_year_and_year_transition() {
        let anchor = ms("2027-12-31T00:00:00Z");
        assert_eq!(
            period_at(anchor, ms("2028-02-29T00:00:00Z")),
            (ms("2028-02-29T00:00:00Z"), ms("2028-03-31T00:00:00Z"))
        );
    }
}
