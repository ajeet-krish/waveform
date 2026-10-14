//! Weekly training volume aggregation.
//!
//! Weeks are Monday-start to match the platform-wide convention (see
//! docs/architecture.md). This is the first ported metric; more of
//! `fitness_control_center/src-tauri/src/commands/analytics.rs` follows in
//! later phases.

use chrono::{Datelike, Duration, NaiveDate};
use serde::Serialize;

/// Total lifted volume for one Monday-start week.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WeeklyVolume {
    /// Monday of the week.
    pub week_start: NaiveDate,
    /// Sum of `weight_kg * reps` across working sets, in kg.
    pub total_kg: f64,
}

/// First Monday (Monday-start week) containing `date`.
pub fn week_start(date: NaiveDate) -> NaiveDate {
    let days_from_monday = i64::from(date.weekday().num_days_from_monday());
    date - Duration::days(days_from_monday)
}

/// Aggregate `(local_date, volume_kg)` entries into Monday-start weeks,
/// sorted by `week_start` ascending. Entries on the same week are summed.
pub fn weekly_volume(entries: &[(NaiveDate, f64)]) -> Vec<WeeklyVolume> {
    let mut weeks: Vec<WeeklyVolume> = Vec::new();
    for &(local_date, volume_kg) in entries {
        let start = week_start(local_date);
        match weeks.last_mut() {
            Some(last) if last.week_start == start => last.total_kg += volume_kg,
            _ => weeks.push(WeeklyVolume {
                week_start: start,
                total_kg: volume_kg,
            }),
        }
    }
    weeks.sort_by_key(|week| week.week_start);
    // Merge again after sorting in case input was not grouped by week.
    weeks.dedup_by(|a, b| {
        if a.week_start == b.week_start {
            b.total_kg += a.total_kg;
            true
        } else {
            false
        }
    });
    weeks
}

#[cfg(test)]
mod tests {
    use super::{week_start, weekly_volume};
    use chrono::NaiveDate;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
    }

    #[test]
    fn week_start_is_monday() {
        // 2026-10-14 is a Wednesday; its week starts Monday 2026-10-12.
        assert_eq!(week_start(date(2026, 10, 14)), date(2026, 10, 12));
        // Sunday belongs to the week that started six days earlier.
        assert_eq!(week_start(date(2026, 10, 11)), date(2026, 10, 5));
        // Monday maps to itself.
        assert_eq!(week_start(date(2026, 10, 12)), date(2026, 10, 12));
    }

    #[test]
    fn entries_group_into_weeks() {
        let entries = [
            (date(2026, 10, 13), 200.0),
            (date(2026, 10, 12), 100.0),
            (date(2026, 10, 11), 50.0),
            (date(2026, 9, 30), 75.0),
        ];
        let weeks = weekly_volume(&entries);
        assert_eq!(weeks.len(), 3);
        assert_eq!(weeks[0].week_start, date(2026, 9, 28));
        assert_eq!(weeks[0].total_kg, 75.0);
        assert_eq!(weeks[1].week_start, date(2026, 10, 5));
        assert_eq!(weeks[1].total_kg, 50.0);
        assert_eq!(weeks[2].week_start, date(2026, 10, 12));
        assert_eq!(weeks[2].total_kg, 300.0);
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(weekly_volume(&[]).is_empty());
    }
}
