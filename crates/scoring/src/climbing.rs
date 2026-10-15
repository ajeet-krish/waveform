//! Climbing V-points.
//!
//! V-points reward sends with exponential weight: a send at numeric grade `g`
//! is worth `2^g` points. The climbing leaderboard sums V-points over a
//! window and also reports the hardest grade. Grades are the numeric V scale
//! (0 for a warm-up slab, roughly 0 through 16 in practice).

/// Highest numeric grade on the V scale. Grades outside `0..=MAX_V_GRADE`
/// are clamped, matching the `climb_grade_value` CHECK in
/// migrations/0003_hardening.sql.
pub const MAX_V_GRADE: i32 = 16;

/// Points for a single send at `grade` on the V scale. Out-of-range grades
/// clamp into `0..=MAX_V_GRADE`, so a mistyped or hostile grade can never
/// produce negative or runaway points.
pub fn v_points(grade: i32) -> f64 {
    2_f64.powi(grade.clamp(0, MAX_V_GRADE))
}

/// Sum of V-points for a set of sends.
pub fn total_v_points(grades: &[i32]) -> f64 {
    grades.iter().map(|&grade| v_points(grade)).sum()
}

#[cfg(test)]
mod tests {
    use super::{total_v_points, v_points, MAX_V_GRADE};

    #[test]
    fn known_grade_values() {
        assert_eq!(v_points(0), 1.0);
        assert_eq!(v_points(2), 4.0);
        assert_eq!(v_points(4), 16.0);
        assert_eq!(v_points(5), 32.0);
    }

    #[test]
    fn out_of_range_grades_clamp_into_the_v_scale() {
        // Negative grades cannot mint fractional points, and absurdly
        // large grades cap at MAX_V_GRADE instead of overflowing to
        // infinity.
        assert_eq!(v_points(-3), v_points(0));
        assert_eq!(v_points(10_000), v_points(MAX_V_GRADE));
        assert!(v_points(i32::MAX).is_finite());
        assert_eq!(v_points(MAX_V_GRADE), 65536.0);
    }

    #[test]
    fn totals_sum_sends() {
        assert_eq!(total_v_points(&[0, 2, 4]), 21.0);
        assert_eq!(total_v_points(&[5, 5, 5]), 96.0);
        assert_eq!(total_v_points(&[]), 0.0);
    }

    #[test]
    fn harder_grades_dominate() {
        let easy = total_v_points(&[0, 0, 0, 0, 0, 0, 0, 0]);
        let hard = total_v_points(&[4]);
        assert!(hard > easy);
    }
}
