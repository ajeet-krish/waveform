//! Effort Points domain coverage: per-discipline intensity, bounded bonuses,
//! the inclusive 100 EP/day cap, and degenerate days.
//!
//! EP is the heatmap currency only (scoring ADR 2026-10-14), so the cap and
//! its boundaries are contract-level behavior: nothing can ever push a day
//! past 100 EP, and bonuses are individually bounded.

use liftlog_scoring::effort::DAILY_EP_CAP;
use liftlog_scoring::{
    effort_points, effort_points_daily, Discipline, EffortBonuses, SessionEffort,
};

fn assert_approx(actual: f64, expected: f64) {
    let tolerance = 1e-9;
    assert!(
        (actual - expected).abs() < tolerance,
        "expected {expected}, got {actual}"
    );
}

fn session(minutes: f64, discipline: Discipline, bonuses: EffortBonuses) -> SessionEffort {
    SessionEffort {
        minutes,
        discipline,
        bonuses,
    }
}

#[test]
fn zero_minute_day_without_bonuses_scores_zero() {
    let none = EffortBonuses::default();
    for discipline in [
        Discipline::Strength,
        Discipline::Climbing,
        Discipline::Cycling,
    ] {
        assert_eq!(effort_points(0.0, discipline, &none), 0.0);
    }
    assert_eq!(effort_points_daily(&[]), 0.0);
    assert_eq!(
        effort_points_daily(&[session(0.0, Discipline::Strength, none)]),
        0.0
    );
}

#[test]
fn zero_minute_day_still_counts_bonuses() {
    // A 10-minute PR-only session is possible; bonuses are not minutes-bound.
    let bonuses = EffortBonuses {
        pr_count: 2,
        sends: 0,
        elevation_m: 0.0,
    };
    assert_approx(effort_points(0.0, Discipline::Strength, &bonuses), 4.0);
}

#[test]
fn per_discipline_intensity_weights_minutes() {
    let none = EffortBonuses::default();
    assert_approx(effort_points(60.0, Discipline::Strength, &none), 60.0);
    assert_approx(effort_points(60.0, Discipline::Climbing, &none), 66.0);
    assert_approx(effort_points(60.0, Discipline::Cycling, &none), 54.0);
    // Fractional minutes pass through unrounded.
    assert_approx(effort_points(90.9, Discipline::Strength, &none), 90.9);
    assert_approx(effort_points(1.0, Discipline::Climbing, &none), 1.1);
}

#[test]
fn each_bonus_type_is_individually_capped() {
    let prs_maxed = EffortBonuses {
        pr_count: 1_000_000,
        sends: 0,
        elevation_m: 0.0,
    };
    assert_approx(effort_points(0.0, Discipline::Strength, &prs_maxed), 10.0);

    let sends_maxed = EffortBonuses {
        pr_count: 0,
        sends: 1_000_000,
        elevation_m: 0.0,
    };
    assert_approx(effort_points(0.0, Discipline::Climbing, &sends_maxed), 10.0);

    let elevation_maxed = EffortBonuses {
        pr_count: 0,
        sends: 0,
        elevation_m: 1_000_000.0,
    };
    assert_approx(
        effort_points(0.0, Discipline::Cycling, &elevation_maxed),
        15.0,
    );
}

#[test]
fn bonuses_cannot_push_a_day_past_the_cap() {
    let maxed = EffortBonuses {
        pr_count: 1_000,
        sends: 1_000,
        elevation_m: 100_000.0,
    };
    // 90 base (cycling) + 35 max bonuses = 125 before the cap.
    let day = [session(100.0, Discipline::Cycling, maxed)];
    assert_eq!(effort_points_daily(&day), DAILY_EP_CAP);

    // Even a zero-minute day of pure bonuses cannot exceed the cap.
    let bonus_only = [session(0.0, Discipline::Strength, maxed)];
    assert_eq!(effort_points_daily(&bonus_only), 35.0);
    // Four zero-minute maxed sessions sum to 140 bonus EP; the cap bites.
    let bonus_storm = [
        session(0.0, Discipline::Strength, maxed),
        session(0.0, Discipline::Climbing, maxed),
        session(0.0, Discipline::Cycling, maxed),
        session(0.0, Discipline::Strength, maxed),
    ];
    assert_eq!(effort_points_daily(&bonus_storm), DAILY_EP_CAP);
}

#[test]
fn the_daily_cap_is_inclusive_and_unrounded() {
    let none = EffortBonuses::default();
    let just_under = [session(99.5, Discipline::Strength, none)];
    assert_approx(effort_points_daily(&just_under), 99.5);

    let exactly_at_cap = [session(100.0, Discipline::Strength, none)];
    assert_eq!(effort_points_daily(&exactly_at_cap), DAILY_EP_CAP);

    let just_over = [session(100.5, Discipline::Strength, none)];
    assert_eq!(effort_points_daily(&just_over), DAILY_EP_CAP);
}

#[test]
fn effort_is_monotonic_in_minutes() {
    let none = EffortBonuses::default();
    for discipline in [
        Discipline::Strength,
        Discipline::Climbing,
        Discipline::Cycling,
    ] {
        let mut previous = effort_points(0.0, discipline, &none);
        for step in 1..=50 {
            let minutes = f64::from(step) * 3.7;
            let current = effort_points(minutes, discipline, &none);
            assert!(
                current >= previous,
                "effort dropped when minutes grew at {minutes}"
            );
            previous = current;
        }
    }
}

#[test]
fn degenerate_inputs_clamp_to_zero() {
    let none = EffortBonuses::default();
    assert_eq!(effort_points(-45.0, Discipline::Strength, &none), 0.0);

    let negative_elevation = EffortBonuses {
        pr_count: 0,
        sends: 0,
        elevation_m: -500.0,
    };
    assert_eq!(
        effort_points(30.0, Discipline::Cycling, &negative_elevation),
        27.0
    );
}

#[test]
fn bonuses_add_assign_sums_each_field() {
    let mut total = EffortBonuses {
        pr_count: 1,
        sends: 2,
        elevation_m: 100.0,
    };
    total += EffortBonuses {
        pr_count: 3,
        sends: 4,
        elevation_m: 250.0,
    };
    assert_eq!(
        total,
        EffortBonuses {
            pr_count: 4,
            sends: 6,
            elevation_m: 350.0,
        }
    );
}

#[test]
fn property_daily_total_never_leaves_the_0_to_100_band() {
    // Sweep a grid of plausible and implausible days; the cap and clamps
    // must keep every day inside [0, 100].
    for &minutes in &[0.0, 1.0, 45.0, 90.0, 600.0, -30.0] {
        for discipline in [
            Discipline::Strength,
            Discipline::Climbing,
            Discipline::Cycling,
        ] {
            for &sends in &[0_u32, 7, 500] {
                let day = [
                    session(
                        minutes,
                        discipline,
                        EffortBonuses {
                            pr_count: 3,
                            sends,
                            elevation_m: 850.0,
                        },
                    ),
                    session(minutes / 2.0, discipline, EffortBonuses::default()),
                ];
                let total = effort_points_daily(&day);
                assert!(
                    (0.0..=DAILY_EP_CAP).contains(&total),
                    "daily EP {total} outside [0, {DAILY_EP_CAP}]"
                );
            }
        }
    }
}
