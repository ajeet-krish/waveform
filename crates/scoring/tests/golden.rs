//! Golden vector fence shared with the TypeScript scoring package.
//!
//! `packages/scoring/golden/scoring.golden.json` is the single source of
//! expected values for Brzycki e1RM, climbing V-points, and Effort Points.
//! The TypeScript package (`@waveform/scoring`) runs the same file against
//! its port, so any formula divergence fails one side of the fence.

use serde::Deserialize;
use waveform_scoring::{
    e1rm_brzycki, effort_points, effort_points_daily, total_v_points, v_points, Discipline,
    EffortBonuses, SessionEffort,
};

/// The shared vector file, relative to this test source.
const GOLDEN_JSON: &str = include_str!("../../../packages/scoring/golden/scoring.golden.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    version: u32,
    tolerance: f64,
    e1rm: Vec<E1rmVector>,
    v_points: Vec<VPointsVector>,
    total_v_points: Vec<TotalVPointsVector>,
    effort_points: Vec<EffortPointsVector>,
    effort_points_daily: Vec<EffortPointsDailyVector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct E1rmVector {
    weight_kg: f64,
    reps: u32,
    expected: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VPointsVector {
    grade: i32,
    expected: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TotalVPointsVector {
    grades: Vec<i32>,
    expected: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffortPointsVector {
    minutes: f64,
    discipline: String,
    bonuses: GoldenBonuses,
    expected: f64,
    /// JSON cannot carry NaN, so these flags stand in for a NaN minutes or
    /// bonus elevation and fence the JS/Rust clamp agreement.
    #[serde(default)]
    minutes_nan: bool,
    #[serde(default)]
    elevation_m_nan: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffortPointsDailyVector {
    sessions: Vec<GoldenSession>,
    expected: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenSession {
    minutes: f64,
    discipline: String,
    bonuses: GoldenBonuses,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenBonuses {
    pr_count: u32,
    sends: u32,
    elevation_m: f64,
}

impl GoldenBonuses {
    fn to_bonuses(&self) -> EffortBonuses {
        EffortBonuses {
            pr_count: self.pr_count,
            sends: self.sends,
            elevation_m: self.elevation_m,
        }
    }
}

impl GoldenSession {
    fn to_session(&self) -> SessionEffort {
        SessionEffort {
            minutes: self.minutes,
            discipline: parse_discipline(&self.discipline),
            bonuses: self.bonuses.to_bonuses(),
        }
    }
}

fn load_golden() -> GoldenFile {
    serde_json::from_str(GOLDEN_JSON).expect("golden file must deserialize")
}

fn assert_approx(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() < tolerance,
        "expected {expected} (+/- {tolerance}), got {actual}"
    );
}

fn parse_discipline(raw: &str) -> Discipline {
    match raw {
        "strength" => Discipline::Strength,
        "climbing" => Discipline::Climbing,
        "cycling" => Discipline::Cycling,
        "run" => Discipline::Run,
        "hike" => Discipline::Hike,
        "swim" => Discipline::Swim,
        other => panic!("unknown discipline in golden file: {other}"),
    }
}

#[test]
fn golden_file_is_version_one_with_non_empty_vector_lists() {
    let golden = load_golden();
    assert_eq!(golden.version, 1);
    assert!(golden.tolerance > 0.0, "tolerance must be positive");
    assert!(!golden.e1rm.is_empty(), "e1rm vectors missing");
    assert!(!golden.v_points.is_empty(), "vPoints vectors missing");
    assert!(
        !golden.total_v_points.is_empty(),
        "totalVPoints vectors missing"
    );
    assert!(
        !golden.effort_points.is_empty(),
        "effortPoints vectors missing"
    );
    assert!(
        !golden.effort_points_daily.is_empty(),
        "effortPointsDaily vectors missing"
    );
}

#[test]
fn e1rm_vectors_match_the_rust_implementation() {
    let golden = load_golden();
    for vector in &golden.e1rm {
        assert_approx(
            e1rm_brzycki(vector.weight_kg, vector.reps),
            vector.expected,
            golden.tolerance,
        );
    }
}

#[test]
fn v_points_vectors_match_the_rust_implementation() {
    let golden = load_golden();
    for vector in &golden.v_points {
        assert_approx(v_points(vector.grade), vector.expected, golden.tolerance);
    }
}

#[test]
fn total_v_points_vectors_match_the_rust_implementation() {
    let golden = load_golden();
    for vector in &golden.total_v_points {
        assert_approx(
            total_v_points(&vector.grades),
            vector.expected,
            golden.tolerance,
        );
    }
}

#[test]
fn effort_points_vectors_match_the_rust_implementation() {
    let golden = load_golden();
    for vector in &golden.effort_points {
        let discipline = parse_discipline(&vector.discipline);
        let minutes = if vector.minutes_nan {
            f64::NAN
        } else {
            vector.minutes
        };
        let mut bonuses = vector.bonuses.to_bonuses();
        if vector.elevation_m_nan {
            bonuses.elevation_m = f64::NAN;
        }
        assert_approx(
            effort_points(minutes, discipline, &bonuses),
            vector.expected,
            golden.tolerance,
        );
    }
}

#[test]
fn effort_points_daily_vectors_match_the_rust_implementation() {
    let golden = load_golden();
    for vector in &golden.effort_points_daily {
        let sessions: Vec<SessionEffort> = vector
            .sessions
            .iter()
            .map(GoldenSession::to_session)
            .collect();
        assert_approx(
            effort_points_daily(&sessions),
            vector.expected,
            golden.tolerance,
        );
    }
}
