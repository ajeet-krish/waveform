//! Monday-start week math at year boundaries and with unordered input.
//!
//! `week_start` underpins weekly volume and the Consistency board's weekly
//! streak tie-break, so year rollovers must not orphan entries into phantom
//! weeks.

use chrono::{Datelike, NaiveDate};
use liftlog_analytics::volume::{week_start, weekly_volume};

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
}

#[test]
fn week_start_rolls_back_across_year_boundaries() {
    // 2026-01-01 is a Thursday; its week began Monday 2025-12-29.
    assert_eq!(week_start(date(2026, 1, 1)), date(2025, 12, 29));
    // Sunday 2027-01-03 belongs to the week that started 2026-12-28.
    assert_eq!(week_start(date(2027, 1, 3)), date(2026, 12, 28));
    // Tuesday 2024-12-31 starts on Monday 2024-12-30 (leap year).
    assert_eq!(week_start(date(2024, 12, 31)), date(2024, 12, 30));
    // Monday maps to itself in every year.
    assert_eq!(week_start(date(2025, 12, 29)), date(2025, 12, 29));
}

#[test]
fn week_start_output_is_always_a_monday() {
    // Sweep a full leap year; every output must satisfy the Monday contract.
    let mut day = date(2024, 1, 1);
    while day <= date(2024, 12, 31) {
        let start = week_start(day);
        assert_eq!(
            start.weekday(),
            chrono::Weekday::Mon,
            "week_start({day}) is not a Monday"
        );
        assert!(start <= day && day - start < chrono::Duration::days(7));
        day = day.succ_opt().expect("date successor");
    }
}

#[test]
fn weekly_volume_is_order_independent() {
    let entries = [
        (date(2025, 12, 31), 100.0),
        (date(2026, 1, 1), 200.0),
        (date(2026, 1, 5), 50.0),
        (date(2025, 12, 29), 25.0),
    ];
    let mut reversed = entries;
    reversed.reverse();

    let weeks = weekly_volume(&entries);
    let weeks_reversed = weekly_volume(&reversed);
    assert_eq!(weeks, weeks_reversed, "aggregation must ignore input order");

    // 2025-12-29 (Mon) .. 2026-01-04 is one week: 25 + 100 + 200 = 325.
    assert_eq!(weeks.len(), 2);
    assert_eq!(weeks[0].week_start, date(2025, 12, 29));
    assert_eq!(weeks[0].total_kg, 325.0);
    assert_eq!(weeks[1].week_start, date(2026, 1, 5));
    assert_eq!(weeks[1].total_kg, 50.0);
}
