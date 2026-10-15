//! Brzycki estimated one-rep max.
//!
//! Formula: `e1rm = w / (1.0278 - 0.0278 * r)`. A single rep or fewer is its
//! own e1RM. The same formula is embedded in `set_entries.e1rm_kg` in
//! `migrations/0001_init.sql`; keep the two in sync.

/// Brzycki constant applied to the numerator side of the curve.
const BRZYCKI_A: f64 = 1.0278;

/// Brzycki constant scaled by the rep count.
const BRZYCKI_B: f64 = 0.0278;

/// Estimate the one-rep max for a set using the Brzycki formula.
///
/// Sets with `reps <= 1` return the lifted weight unchanged. The schema
/// constrains reps to `1..=36`, where the denominator stays positive; for
/// defensive use the function falls back to the raw weight if the
/// denominator would be non-positive.
pub fn e1rm_brzycki(weight_kg: f64, reps: u32) -> f64 {
    if reps <= 1 {
        return weight_kg;
    }
    let denominator = BRZYCKI_A - BRZYCKI_B * f64::from(reps);
    if denominator <= f64::EPSILON {
        weight_kg
    } else {
        weight_kg / denominator
    }
}

#[cfg(test)]
mod tests {
    use super::e1rm_brzycki;

    fn assert_approx(actual: f64, expected: f64) {
        let tolerance = 1e-6;
        assert!(
            (actual - expected).abs() < tolerance,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn single_rep_is_its_own_e1rm() {
        assert_eq!(e1rm_brzycki(100.0, 0), 100.0);
        assert_eq!(e1rm_brzycki(100.0, 1), 100.0);
    }

    #[test]
    fn known_five_rep_value() {
        // 100 / (1.0278 - 0.0278 * 5) = 100 / 0.8888
        assert_approx(e1rm_brzycki(100.0, 5), 112.511251);
    }

    #[test]
    fn known_ten_rep_value() {
        // 60 / (1.0278 - 0.0278 * 10) = 60 / 0.7498
        assert_approx(e1rm_brzycki(60.0, 10), 80.021339);
    }

    #[test]
    fn e1rm_grows_with_reps() {
        let one = e1rm_brzycki(100.0, 1);
        let five = e1rm_brzycki(100.0, 5);
        let twelve = e1rm_brzycki(100.0, 12);
        assert!(one < five && five < twelve);
    }

    #[test]
    fn zero_weight_is_zero() {
        assert_eq!(e1rm_brzycki(0.0, 8), 0.0);
    }

    #[test]
    fn extreme_reps_fall_back_to_weight() {
        // 1.0278 - 0.0278 * 37 is negative; the guard returns raw weight.
        assert_eq!(e1rm_brzycki(100.0, 37), 100.0);
    }
}
