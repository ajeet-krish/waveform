//! Brzycki e1RM coverage across the full rep domain and beyond.
//!
//! The schema constrains reps to 1..=36 (migrations/0001_init.sql); these
//! tests pin the formula at representative points of that domain, verify the
//! guards outside it, and check the monotonicity/linearity properties the
//! PR-ranking logic relies on.

use waveform_scoring::e1rm_brzycki;

fn assert_approx(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() < tolerance,
        "expected {expected} (+/- {tolerance}), got {actual}"
    );
}

#[test]
fn known_values_across_the_rep_domain() {
    // Independently computed: w / (1.0278 - 0.0278 * r).
    let cases: &[(f64, u32, f64)] = &[
        (100.0, 1, 100.000000),
        (100.0, 2, 102.859494),
        (100.0, 3, 105.887336),
        (100.0, 5, 112.511251),
        (100.0, 8, 124.161907),
        (100.0, 10, 133.368898),
        (100.0, 12, 144.050706),
        (100.0, 15, 163.719712),
        (100.0, 20, 211.954218),
        (100.0, 25, 300.480769),
        (100.0, 30, 515.995872),
        (100.0, 36, 3703.703704),
        (60.0, 1, 60.000000),
        (60.0, 10, 80.021339),
        (60.0, 20, 127.172531),
        (60.0, 36, 2222.222222),
        (200.0, 5, 225.022502),
        (200.0, 20, 423.908436),
    ];
    for &(weight, reps, expected) in cases {
        assert_approx(e1rm_brzycki(weight, reps), expected, 1e-6);
    }
}

#[test]
fn every_schema_rep_count_is_finite_and_at_least_the_lifted_weight() {
    for &weight in &[1.0, 35.0, 100.0, 232.5] {
        for reps in 1..=36_u32 {
            let e1rm = e1rm_brzycki(weight, reps);
            assert!(e1rm.is_finite(), "non-finite e1rm for {weight} kg x {reps}");
            assert!(
                e1rm >= weight,
                "e1rm {e1rm} below weight {weight} at {reps} reps"
            );
            if reps == 1 {
                assert_eq!(e1rm, weight, "one rep must be its own e1rm");
            } else {
                assert!(e1rm > weight, "e1rm must exceed weight for {reps} reps");
            }
        }
    }
}

#[test]
fn e1rm_is_strictly_monotonic_in_reps_for_fixed_weight() {
    let mut previous = e1rm_brzycki(100.0, 1);
    for reps in 2..=36_u32 {
        let current = e1rm_brzycki(100.0, reps);
        assert!(
            current > previous,
            "e1rm not increasing at {reps} reps: {current} <= {previous}"
        );
        previous = current;
    }
}

#[test]
fn e1rm_scales_linearly_in_weight() {
    for reps in [2_u32, 5, 10, 20, 36] {
        let base = e1rm_brzycki(100.0, reps);
        assert_approx(e1rm_brzycki(250.0, reps), 2.5 * base, 1e-9);
        assert_approx(
            e1rm_brzycki(62.5, reps) + e1rm_brzycki(37.5, reps),
            base,
            1e-9,
        );
    }
}

#[test]
fn guards_outside_the_schema_domain_return_the_raw_weight() {
    // Defensive fallback: denominator <= 0 (reps >= 37) and the sub-one-rep
    // case both return the weight unchanged.
    for reps in [0_u32, 37, 40, 100, 1_000, u32::MAX] {
        assert_eq!(
            e1rm_brzycki(100.0, reps),
            100.0,
            "guard failed at {reps} reps"
        );
    }
}

#[test]
fn the_schema_max_of_36_reps_is_the_sane_extremum() {
    // At the CHECK-constraint ceiling the denominator is still positive:
    // 1.0278 - 0.0278 * 36 = 0.027, so 100 kg x 36 estimates ~3703.7 kg.
    assert_approx(e1rm_brzycki(100.0, 36), 3703.703704, 1e-6);
    // One rep past the ceiling the guard kicks in (documented discontinuity,
    // defensive only; the schema prevents this state).
    assert_eq!(e1rm_brzycki(100.0, 37), 100.0);
}

#[test]
fn zero_weight_stays_zero_and_negative_weight_stays_linear() {
    for reps in [1_u32, 5, 20, 36] {
        assert_eq!(e1rm_brzycki(0.0, reps), 0.0);
        // Defensive: no clamping, the formula stays linear for negatives too.
        assert_approx(e1rm_brzycki(-100.0, 5), -112.511251, 1e-6);
    }
}
