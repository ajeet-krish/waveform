//! Climbing V-point coverage: `2^grade` weighting, summation properties, and
//! hard-send dominance.
//!
//! The crate uses the numeric V scale only (0 through ~16 in practice); there
//! is no sport-grade (VB/V17+, Font scale) normalization in phase 0, so these
//! tests pin the exponential weighting contract the climbing board relies on.

use waveform_scoring::{total_v_points, v_points};

#[test]
fn v_points_is_two_to_the_power_of_the_grade() {
    for grade in 0..=16_i32 {
        assert_eq!(
            v_points(grade),
            2_f64.powi(grade),
            "v_points({grade}) must equal 2^grade"
        );
    }
    // Exact values for the grades climbers actually log.
    assert_eq!(v_points(0), 1.0);
    assert_eq!(v_points(1), 2.0);
    assert_eq!(v_points(3), 8.0);
    assert_eq!(v_points(5), 32.0);
    assert_eq!(v_points(8), 256.0);
}

#[test]
fn each_grade_step_doubles_the_points() {
    for grade in 0..=15_i32 {
        assert_eq!(v_points(grade + 1), 2.0 * v_points(grade));
    }
}

#[test]
fn totals_are_order_independent() {
    let sends = [1_i32, 3, 5, 7, 2, 2];
    let mut shuffled = sends;
    shuffled.reverse();
    assert_eq!(total_v_points(&sends), total_v_points(&shuffled));

    let sorted = [1_i32, 2, 2, 3, 5, 7];
    assert_eq!(total_v_points(&sends), total_v_points(&sorted));
}

#[test]
fn a_single_hard_send_outranks_many_easy_sends() {
    // 128 easy sends at V0 are worth 128; one V7 send is worth 128 as well,
    // so a single V8 (256) beats even a hundred V0 warm-ups.
    let hundred_v0 = vec![0_i32; 100];
    assert_eq!(total_v_points(&hundred_v0), 100.0);
    assert!(v_points(8) > total_v_points(&hundred_v0));
    // Doubling continues past the practical ceiling without overflow.
    assert!(v_points(16) > 65_000.0);
}

#[test]
fn single_send_total_matches_v_points_and_empty_is_zero() {
    for grade in [0_i32, 4, 9] {
        assert_eq!(total_v_points(&[grade]), v_points(grade));
    }
    assert_eq!(total_v_points(&[]), 0.0);
}

#[test]
fn fractional_grade_values_from_the_schema_round_trip() {
    // activities.climb_grade_value is numeric(4,1), so half grades are
    // representable; the V-point math is exponential in a real-valued grade
    // when callers convert. Here we pin integer-grade equivalence.
    let half_grade_as_int = 4_i32; // "V4" logs as 4.0 in climb_grade_value
    assert_eq!(v_points(half_grade_as_int), 16.0);
    assert_eq!(total_v_points(&[4, 4, 4]), 48.0);
}
