//! Leaderboard ranking: shared-rank assignment and the per-discipline
//! metrics from the locked scoring ADR (docs/decisions.md 2026-10-14
//! "Scoring model finalized").
//!
//! This module is pure: it takes per-member aggregate numbers already
//! summed by `waveform-db` and returns them ranked. The universal board
//! is Consistency (active days, tie-broken by the weekly streak of weeks
//! with at least [`MIN_STREAK_WEEK_ACTIVE_DAYS`] active days); the
//! per-discipline boards are lifting (weekly volume, best e1RM per marquee
//! lift, relative e1RM / bodyweight), cycling (distance, elevation), and
//! climbing (V-points, hardest grade). Effort Points are deliberately not
//! a board: they are the heatmap currency only.
//!
//! Ties share the lowest rank of their group, so ranks read `1, 2, 2, 4`.
//! Weeks are Monday-start everywhere (see [`week_start`](crate::volume::week_start));
//! the weekly streak treats a missing week as a gap.

use chrono::{Duration, NaiveDate};

use waveform_scoring::v_points;

/// The marquee lifts behind the absolute-e1RM boards, as the friendly
/// labels the response exposes. Matching happens on
/// [`MARQUEE_LIFT_ALIASES`].
pub const MARQUEE_LIFTS: [&str; 4] = ["Back Squat", "Bench Press", "Deadlift", "Overhead Press"];

/// Catalog `lower(name)` values that map onto each marquee lift, in the
/// same order as [`MARQUEE_LIFTS`]. The seed catalog keeps the barbell
/// movement under a parenthetical equipment suffix ("Squat (Barbell)"),
/// and a custom exercise may use the bare movement name, so each lift
/// lists both spellings.
pub const MARQUEE_LIFT_ALIASES: [&[&str]; 4] = [
    &["squat (barbell)", "back squat"],
    &["bench press (barbell)", "bench press"],
    &["deadlift (barbell)", "deadlift"],
    &["overhead press (barbell)", "overhead press"],
];

/// Flatten [`MARQUEE_LIFT_ALIASES`] into parallel `(alias, canonical)`
/// lists for the SQL join: entry `i` of each list belongs together.
pub fn marquee_lift_alias_pairs() -> (Vec<&'static str>, Vec<&'static str>) {
    let mut aliases = Vec::new();
    let mut canonicals = Vec::new();
    for (lift, lift_aliases) in MARQUEE_LIFTS.iter().zip(MARQUEE_LIFT_ALIASES) {
        for alias in lift_aliases {
            aliases.push(*alias);
            canonicals.push(*lift);
        }
    }
    (aliases, canonicals)
}

/// A week counts toward the Consistency streak when it has at least this
/// many active days.
pub const MIN_STREAK_WEEK_ACTIVE_DAYS: i32 = 3;

/// One member on a board before ranking: the metric to rank on plus an
/// optional higher-wins tie-break (0 when unused).
#[derive(Debug, Clone, PartialEq)]
pub struct BoardMember<T, V, B = i32> {
    /// Opaque member key supplied by the caller (a user id in the API).
    pub member: T,
    /// The metric value; higher ranks better.
    pub value: V,
    /// Tie-break value; higher ranks better. Equal value and tie-break
    /// pairs share a rank.
    pub tiebreak: B,
}

/// A ranked member: the original key, the metric, the tie-break, and the
/// shared rank (`1, 2, 2, 4`).
#[derive(Debug, Clone, PartialEq)]
pub struct RankedEntry<T, V, B = i32> {
    pub member: T,
    pub value: V,
    pub tiebreak: B,
    pub rank: u32,
}

/// Rank members by `value` descending, then `tiebreak` descending. Equal
/// `(value, tiebreak)` pairs share the lowest rank of their tie group, so
/// the sequence is `1, 2, 2, 4` rather than `1, 2, 3, 4`. The sort is
/// stable, so members that compare equal keep their input order.
pub fn rank<T, V, B>(members: &[BoardMember<T, V, B>]) -> Vec<RankedEntry<T, V, B>>
where
    T: Clone,
    V: PartialOrd + PartialEq + Clone,
    B: PartialOrd + PartialEq + Clone,
{
    let mut order: Vec<usize> = (0..members.len()).collect();
    order.sort_by(|&a, &b| {
        let left = &members[a];
        let right = &members[b];
        compare_desc(&left.value, &right.value)
            .then_with(|| compare_desc(&left.tiebreak, &right.tiebreak))
    });

    let mut ranked = Vec::with_capacity(members.len());
    let mut previous_rank = 0;
    for (position, &index) in order.iter().enumerate() {
        let member = &members[index];
        let tied = position > 0 && {
            let previous = &members[order[position - 1]];
            member.value == previous.value && member.tiebreak == previous.tiebreak
        };
        let rank = if tied {
            previous_rank
        } else {
            u32::try_from(position + 1).unwrap_or(u32::MAX)
        };
        previous_rank = rank;
        ranked.push(RankedEntry {
            member: member.member.clone(),
            value: member.value.clone(),
            tiebreak: member.tiebreak.clone(),
            rank,
        });
    }
    ranked
}

/// Descending comparator; values that do not compare (NaN) sort as equal
/// so the stable sort keeps their input order instead of panicking.
fn compare_desc<T: PartialOrd>(left: &T, right: &T) -> std::cmp::Ordering {
    right.partial_cmp(left).unwrap_or(std::cmp::Ordering::Equal)
}

/// Rank a single-metric board (lifting volume, cycling distance and
/// elevation, best e1RM per marquee lift). Missing members are the
/// caller's job to fill with zero before calling.
pub fn metric_board<T>(members: &[(T, f64)]) -> Vec<RankedEntry<T, f64, i32>>
where
    T: Clone + PartialEq,
{
    let board: Vec<BoardMember<T, f64, i32>> = members
        .iter()
        .map(|(member, value)| BoardMember {
            member: member.clone(),
            value: *value,
            tiebreak: 0,
        })
        .collect();
    rank(&board)
}

/// Longest run of consecutive Monday-start weeks with at least
/// [`MIN_STREAK_WEEK_ACTIVE_DAYS`] active days. Input order does not
/// matter; a missing week breaks the run.
pub fn weekly_streak(weeks: &[(NaiveDate, i32)]) -> i32 {
    let mut sorted: Vec<(NaiveDate, i32)> = weeks.to_vec();
    sorted.sort_by_key(|&(week_start, _)| week_start);

    let mut best = 0;
    let mut current = 0;
    let mut previous: Option<NaiveDate> = None;
    for (week_start, active_days) in sorted {
        let consecutive = previous.is_some_and(|prev| week_start == prev + Duration::days(7));
        if active_days >= MIN_STREAK_WEEK_ACTIVE_DAYS {
            current = if consecutive { current + 1 } else { 1 };
            best = best.max(current);
        } else {
            current = 0;
        }
        previous = Some(week_start);
    }
    best
}

/// One member's Consistency inputs: active days in the window plus the
/// per-week active-day counts used for the streak tie-break.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsistencyInput<T> {
    pub member: T,
    pub active_days: i32,
    /// Monday-start weeks in the window with their active-day counts.
    pub weekly_active_days: Vec<(NaiveDate, i32)>,
}

/// One ranked member on the Consistency board.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsistencyEntry<T> {
    pub member: T,
    pub active_days: i32,
    pub weekly_streak: i32,
    pub rank: u32,
}

/// Rank the Consistency board by active days, tie-broken by the weekly
/// streak of weeks with at least [`MIN_STREAK_WEEK_ACTIVE_DAYS`] active
/// days.
pub fn consistency_board<T>(inputs: &[ConsistencyInput<T>]) -> Vec<ConsistencyEntry<T>>
where
    T: Clone + PartialEq,
{
    let board: Vec<BoardMember<T, i32, i32>> = inputs
        .iter()
        .map(|input| BoardMember {
            member: input.member.clone(),
            value: input.active_days,
            tiebreak: weekly_streak(&input.weekly_active_days),
        })
        .collect();

    rank(&board)
        .into_iter()
        .map(|entry| ConsistencyEntry {
            member: entry.member,
            active_days: entry.value,
            weekly_streak: entry.tiebreak,
            rank: entry.rank,
        })
        .collect()
}

/// Relative strength: best e1RM divided by bodyweight. `None` when either
/// input is not finite or the bodyweight is not strictly positive, so a
/// member without a plausible bodyweight is left off the board rather
/// than ranked at infinity.
pub fn relative_e1rm_ratio(best_e1rm_kg: f64, bodyweight_kg: f64) -> Option<f64> {
    if !best_e1rm_kg.is_finite() || !bodyweight_kg.is_finite() || bodyweight_kg <= 0.0 {
        return None;
    }
    Some(best_e1rm_kg / bodyweight_kg)
}

/// Decimal places kept on the exposed relative-e1RM ratio. The absolute
/// marquee board publishes the same e1RM the ratio divides by, so rounding
/// the ratio keeps the private bodyweight only approximately recoverable
/// (docs/decisions.md 2026-10-16 "Relative e1RM board rounds the ratio").
pub const RELATIVE_E1RM_RATIO_DECIMALS: u32 = 2;

/// Round a ratio to [`RELATIVE_E1RM_RATIO_DECIMALS`] decimals (half away
/// from zero, like `f64::round`).
fn round_ratio(ratio: f64) -> f64 {
    let scale = 10_f64.powi(RELATIVE_E1RM_RATIO_DECIMALS as i32);
    (ratio * scale).round() / scale
}

/// One member's relative-e1RM inputs. The bodyweight is consumed here and
/// never returned.
#[derive(Debug, Clone, PartialEq)]
pub struct RelativeE1rmInput<T> {
    pub member: T,
    pub best_e1rm_kg: f64,
    pub bodyweight_kg: f64,
}

/// One ranked member on the relative-e1RM board. Only the computed ratio
/// travels, rounded to [`RELATIVE_E1RM_RATIO_DECIMALS`] decimals so the
/// bodyweight stays server-side and is only approximately recoverable.
#[derive(Debug, Clone, PartialEq)]
pub struct RelativeE1rmEntry<T> {
    pub member: T,
    pub ratio: f64,
    pub rank: u32,
}

/// Rank the relative-e1RM board on the rounded ratio. Members without a
/// finite, positive bodyweight are dropped.
pub fn relative_e1rm_board<T>(inputs: &[RelativeE1rmInput<T>]) -> Vec<RelativeE1rmEntry<T>>
where
    T: Clone + PartialEq,
{
    let mut ratios = Vec::new();
    for input in inputs {
        if let Some(ratio) = relative_e1rm_ratio(input.best_e1rm_kg, input.bodyweight_kg) {
            ratios.push((input.member.clone(), round_ratio(ratio)));
        }
    }

    metric_board(&ratios)
        .into_iter()
        .map(|entry| RelativeE1rmEntry {
            member: entry.member,
            ratio: entry.value,
            rank: entry.rank,
        })
        .collect()
}

/// V-points for a set of sends: each `(grade, count)` pair contributes
/// `count * 2^grade`, reusing the shared scoring implementation so the
/// grade clamps match the rest of the platform.
pub fn climbing_points(sends: &[(i32, i32)]) -> f64 {
    sends
        .iter()
        .map(|&(grade, count)| f64::from(count) * v_points(grade))
        .sum()
}

/// Hardest grade with at least one send, or `None` when nothing was sent.
pub fn hardest_grade(sends: &[(i32, i32)]) -> Option<i32> {
    sends
        .iter()
        .filter(|&&(_, count)| count > 0)
        .map(|&(grade, _)| grade)
        .max()
}

/// One member's climbing inputs: `(grade, send count)` pairs in the window.
#[derive(Debug, Clone, PartialEq)]
pub struct ClimbingInput<T> {
    pub member: T,
    pub sends: Vec<(i32, i32)>,
}

/// One ranked member on the climbing board.
#[derive(Debug, Clone, PartialEq)]
pub struct ClimbingEntry<T> {
    pub member: T,
    pub v_points: f64,
    pub hardest_grade: Option<i32>,
    pub rank: u32,
}

/// Rank the climbing board by V-points, tie-broken by hardest grade.
pub fn climbing_board<T>(inputs: &[ClimbingInput<T>]) -> Vec<ClimbingEntry<T>>
where
    T: Clone + PartialEq,
{
    let board: Vec<BoardMember<T, f64, i32>> = inputs
        .iter()
        .map(|input| BoardMember {
            member: input.member.clone(),
            value: climbing_points(&input.sends),
            tiebreak: hardest_grade(&input.sends).unwrap_or(-1),
        })
        .collect();

    rank(&board)
        .into_iter()
        .map(|entry| ClimbingEntry {
            member: entry.member,
            v_points: entry.value,
            hardest_grade: (entry.tiebreak >= 0).then_some(entry.tiebreak),
            rank: entry.rank,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        climbing_board, climbing_points, consistency_board, hardest_grade, metric_board, rank,
        relative_e1rm_board, relative_e1rm_ratio, weekly_streak, BoardMember, ClimbingInput,
        ConsistencyInput, RelativeE1rmInput, MARQUEE_LIFTS, MIN_STREAK_WEEK_ACTIVE_DAYS,
        RELATIVE_E1RM_RATIO_DECIMALS,
    };
    use chrono::NaiveDate;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
    }

    #[test]
    fn ties_share_the_lowest_rank_of_the_group() {
        let board = [
            BoardMember {
                member: "a",
                value: 100.0,
                tiebreak: 0,
            },
            BoardMember {
                member: "b",
                value: 90.0,
                tiebreak: 0,
            },
            BoardMember {
                member: "c",
                value: 90.0,
                tiebreak: 0,
            },
            BoardMember {
                member: "d",
                value: 80.0,
                tiebreak: 0,
            },
        ];
        let ranked = rank(&board);
        let ranks: Vec<u32> = ranked.iter().map(|entry| entry.rank).collect();
        assert_eq!(ranks, vec![1, 2, 2, 4]);
        // The tie group keeps input order (stable sort).
        assert_eq!(ranked[1].member, "b");
        assert_eq!(ranked[2].member, "c");
    }

    #[test]
    fn tiebreak_orders_equal_primary_values() {
        let board = [
            BoardMember {
                member: "low",
                value: 5,
                tiebreak: 1,
            },
            BoardMember {
                member: "high",
                value: 5,
                tiebreak: 9,
            },
            BoardMember {
                member: "top",
                value: 6,
                tiebreak: 0,
            },
        ];
        let ranked = rank(&board);
        assert_eq!(
            ranked.iter().map(|entry| entry.member).collect::<Vec<_>>(),
            vec!["top", "high", "low"]
        );
        // All three have distinct (value, tiebreak) pairs: no shared rank.
        assert_eq!(
            ranked.iter().map(|entry| entry.rank).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn equal_value_and_tiebreak_share_a_rank() {
        let board = [
            BoardMember {
                member: "a",
                value: 3,
                tiebreak: 7,
            },
            BoardMember {
                member: "b",
                value: 3,
                tiebreak: 7,
            },
            BoardMember {
                member: "c",
                value: 1,
                tiebreak: 0,
            },
        ];
        let ranked = rank(&board);
        assert_eq!(
            ranked.iter().map(|entry| entry.rank).collect::<Vec<_>>(),
            vec![1, 1, 3]
        );
    }

    #[test]
    fn metric_board_orders_descending() {
        let ranked = metric_board(&[("a", 10.0), ("b", 30.0), ("c", 20.0)]);
        assert_eq!(
            ranked
                .iter()
                .map(|entry| (entry.member, entry.rank))
                .collect::<Vec<_>>(),
            vec![("b", 1), ("c", 2), ("a", 3)]
        );
    }

    #[test]
    fn empty_board_is_empty() {
        let empty: [BoardMember<&str, f64, i32>; 0] = [];
        assert!(rank(&empty).is_empty());
        assert!(metric_board::<&str>(&[]).is_empty());
    }

    #[test]
    fn weekly_streak_counts_consecutive_qualifying_weeks() {
        // Three consecutive qualifying weeks, then a gap, then one more.
        let weeks = [
            (date(2026, 9, 28), 3),
            (date(2026, 10, 5), 4),
            (date(2026, 10, 12), 3),
            (date(2026, 10, 26), 5),
        ];
        assert_eq!(weekly_streak(&weeks), 3);
    }

    #[test]
    fn weekly_streak_breaks_on_a_non_qualifying_week() {
        // Week 2 has only 2 active days: the run resets.
        let weeks = [
            (date(2026, 10, 5), 3),
            (date(2026, 10, 12), 2),
            (date(2026, 10, 19), 3),
        ];
        assert_eq!(weekly_streak(&weeks), 1);
    }

    #[test]
    fn weekly_streak_ignores_input_order() {
        let ordered = [(date(2026, 10, 5), 3), (date(2026, 10, 12), 3)];
        let reversed = [(date(2026, 10, 12), 3), (date(2026, 10, 5), 3)];
        assert_eq!(weekly_streak(&ordered), 2);
        assert_eq!(weekly_streak(&reversed), 2);
        assert_eq!(weekly_streak(&[]), 0);
    }

    #[test]
    fn consistency_board_tie_breaks_by_streak() {
        let inputs = [
            ConsistencyInput {
                member: "steady",
                active_days: 12,
                weekly_active_days: vec![
                    (date(2026, 9, 28), 3),
                    (date(2026, 10, 5), 3),
                    (date(2026, 10, 12), 3),
                ],
            },
            ConsistencyInput {
                member: "bursty",
                active_days: 12,
                weekly_active_days: vec![
                    (date(2026, 9, 28), 6),
                    (date(2026, 10, 5), 1),
                    (date(2026, 10, 12), 5),
                ],
            },
        ];
        let ranked = consistency_board(&inputs);
        assert_eq!(ranked[0].member, "steady", "longer streak wins the tie");
        assert_eq!(ranked[0].weekly_streak, 3);
        assert_eq!(ranked[0].rank, 1);
        assert_eq!(ranked[1].rank, 2);
    }

    #[test]
    fn consistency_board_ranks_active_days_first() {
        let inputs = [
            ConsistencyInput {
                member: "many",
                active_days: 20,
                weekly_active_days: vec![],
            },
            ConsistencyInput {
                member: "few",
                active_days: 4,
                weekly_active_days: vec![],
            },
        ];
        let ranked = consistency_board(&inputs);
        assert_eq!(ranked[0].member, "many");
        assert_eq!(ranked[0].rank, 1);
        assert_eq!(ranked[1].rank, 2);
    }

    #[test]
    fn relative_ratio_guards_against_bad_bodyweight() {
        assert_eq!(relative_e1rm_ratio(100.0, 50.0), Some(2.0));
        assert_eq!(relative_e1rm_ratio(100.0, 0.0), None);
        assert_eq!(relative_e1rm_ratio(100.0, -1.0), None);
        assert_eq!(relative_e1rm_ratio(100.0, f64::NAN), None);
        assert_eq!(relative_e1rm_ratio(f64::INFINITY, 50.0), None);
    }

    #[test]
    fn relative_e1rm_board_ranks_ratios_and_drops_missing_bodyweight() {
        let inputs = [
            RelativeE1rmInput {
                member: "strong",
                best_e1rm_kg: 150.0,
                bodyweight_kg: 75.0,
            },
            RelativeE1rmInput {
                member: "light",
                best_e1rm_kg: 100.0,
                bodyweight_kg: 50.0,
            },
            RelativeE1rmInput {
                member: "unknown",
                best_e1rm_kg: 120.0,
                bodyweight_kg: 0.0,
            },
        ];
        let ranked = relative_e1rm_board(&inputs);
        assert_eq!(
            ranked.len(),
            2,
            "the member without a bodyweight is dropped"
        );
        assert_eq!(ranked[0].member, "strong");
        assert_eq!(ranked[0].ratio, 2.0);
        assert_eq!(ranked[1].member, "light");
        assert_eq!(ranked[1].ratio, 2.0);
        // Equal ratios share a rank.
        assert_eq!(ranked[0].rank, 1);
        assert_eq!(ranked[1].rank, 1);
    }

    #[test]
    fn relative_e1rm_board_rounds_and_ranks_on_the_rounded_ratio() {
        let inputs = [
            RelativeE1rmInput {
                member: "a",
                best_e1rm_kg: 100.0,
                bodyweight_kg: 3.0,
            },
            RelativeE1rmInput {
                member: "b",
                best_e1rm_kg: 99.99,
                bodyweight_kg: 3.0,
            },
            RelativeE1rmInput {
                member: "c",
                best_e1rm_kg: 120.0,
                bodyweight_kg: 3.0,
            },
        ];
        let ranked = relative_e1rm_board(&inputs);
        assert_eq!(ranked[0].member, "c");
        assert_eq!(ranked[0].ratio, 40.0);
        assert_eq!(ranked[0].rank, 1);
        // 100 / 3 and 99.99 / 3 differ before rounding but both expose
        // 33.33, so the tie is decided on the rounded value.
        assert_eq!(ranked[1].ratio, 33.33);
        assert_eq!(ranked[2].ratio, 33.33);
        assert_eq!(ranked[1].rank, 2);
        assert_eq!(ranked[2].rank, 2);
        assert_eq!(ranked[1].member, "a");
        assert_eq!(ranked[2].member, "b");
        assert_eq!(RELATIVE_E1RM_RATIO_DECIMALS, 2);
    }

    #[test]
    fn climbing_points_sum_two_to_the_grade() {
        assert_eq!(climbing_points(&[(0, 1)]), 1.0);
        assert_eq!(climbing_points(&[(2, 1)]), 4.0);
        assert_eq!(climbing_points(&[(4, 2)]), 32.0);
        assert_eq!(climbing_points(&[(0, 3), (5, 1)]), 3.0 + 32.0);
        assert_eq!(climbing_points(&[]), 0.0);
    }

    #[test]
    fn hardest_grade_ignores_zero_send_counts() {
        assert_eq!(hardest_grade(&[(3, 1), (7, 0), (5, 2)]), Some(5));
        assert_eq!(hardest_grade(&[(4, 0)]), None);
        assert_eq!(hardest_grade(&[]), None);
    }

    #[test]
    fn climbing_board_ranks_v_points_then_hardest_grade() {
        let inputs = [
            ClimbingInput {
                member: "volume",
                sends: vec![(2, 4)],
            },
            ClimbingInput {
                member: "hard",
                sends: vec![(5, 1)],
            },
            // Same V-points as "hard" (32) but an easier hardest grade.
            ClimbingInput {
                member: "many-easy",
                sends: vec![(3, 4)],
            },
        ];
        let ranked = climbing_board(&inputs);
        assert_eq!(ranked[0].member, "hard");
        assert_eq!(ranked[0].v_points, 32.0);
        assert_eq!(ranked[0].hardest_grade, Some(5));
        assert_eq!(ranked[1].member, "many-easy");
        assert_eq!(ranked[1].rank, 2);
        assert_eq!(ranked[2].member, "volume");
        assert_eq!(ranked[2].hardest_grade, Some(2));
    }

    #[test]
    fn marquee_lifts_are_the_locked_base_lifts() {
        assert_eq!(
            MARQUEE_LIFTS,
            ["Back Squat", "Bench Press", "Deadlift", "Overhead Press"]
        );
        assert_eq!(MIN_STREAK_WEEK_ACTIVE_DAYS, 3);
    }

    #[test]
    fn marquee_aliases_flatten_to_parallel_pairs() {
        let (aliases, canonicals) = super::marquee_lift_alias_pairs();
        assert_eq!(aliases.len(), canonicals.len());
        assert_eq!(aliases.len(), 8);
        // Every canonical is one of the exposed lifts.
        assert!(canonicals.iter().all(|lift| MARQUEE_LIFTS.contains(lift)));
        // The catalog's barbell squat spelling maps to the friendly label.
        let squat = aliases
            .iter()
            .position(|alias| *alias == "squat (barbell)")
            .expect("squat alias");
        assert_eq!(canonicals[squat], "Back Squat");
        let bench = aliases
            .iter()
            .position(|alias| *alias == "bench press (barbell)")
            .expect("bench alias");
        assert_eq!(canonicals[bench], "Bench Press");
    }
}
