//! Climbing V-points.
//!
//! V-points reward sends with exponential weight: a send at numeric grade `g`
//! is worth `2^g` points. The climbing leaderboard sums V-points over a
//! window and also reports the hardest grade. Grades are the numeric V scale
//! (0 for a warm-up slab, roughly 0 through 16 in practice).

/// Points for a single send at `grade` on the V scale.
pub fn v_points(grade: i32) -> f64 {
    2_f64.powi(grade)
}

/// Sum of V-points for a set of sends.
pub fn total_v_points(grades: &[i32]) -> f64 {
    grades.iter().map(|&grade| v_points(grade)).sum()
}

#[cfg(test)]
mod tests {
    use super::{total_v_points, v_points};

    #[test]
    fn known_grade_values() {
        assert_eq!(v_points(0), 1.0);
        assert_eq!(v_points(2), 4.0);
        assert_eq!(v_points(4), 16.0);
        assert_eq!(v_points(5), 32.0);
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
