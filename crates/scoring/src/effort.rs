//! Effort Points (EP): the heatmap currency.
//!
//! EP is `minutes x per-discipline intensity` plus bounded bonuses, summed
//! per day and capped at 100 EP. Per the scoring ADR (2026-10-14) EP is the
//! heatmap currency only and never a ranked leaderboard board.

use std::ops::AddAssign;

/// Lifting, climbing, and cycling weight minutes differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Discipline {
    /// Weightlifting sessions.
    Strength,
    /// Indoor or outdoor climbing sessions.
    Climbing,
    /// Cycling sessions.
    Cycling,
}

impl Discipline {
    /// Minutes-to-EP intensity for this discipline.
    pub fn intensity(self) -> f64 {
        match self {
            Discipline::Strength => 1.0,
            Discipline::Climbing => 1.1,
            Discipline::Cycling => 0.9,
        }
    }
}

/// Bounded per-session bonuses. Every bonus type is individually capped so no
/// single axis can dominate a day.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct EffortBonuses {
    /// Personal records set during the session.
    pub pr_count: u32,
    /// Climbing routes sent during the session.
    pub sends: u32,
    /// Elevation gained, in meters (cycling and hiking).
    pub elevation_m: f64,
}

/// A single session's contribution to a day's Effort Points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionEffort {
    pub minutes: f64,
    pub discipline: Discipline,
    pub bonuses: EffortBonuses,
}

/// EP granted per personal record.
const EP_PER_PR: f64 = 2.0;

/// Daily cap on PR bonus EP.
const EP_PR_CAP: f64 = 10.0;

/// EP granted per climbing send.
const EP_PER_SEND: f64 = 1.0;

/// Daily cap on send bonus EP.
const EP_SEND_CAP: f64 = 10.0;

/// EP granted per 100 m of elevation.
const EP_PER_ELEVATION_100M: f64 = 1.0;

/// Daily cap on elevation bonus EP.
const EP_ELEVATION_CAP: f64 = 15.0;

/// Hard daily cap on total Effort Points.
pub const DAILY_EP_CAP: f64 = 100.0;

impl EffortBonuses {
    /// Bounded bonus EP for this session.
    fn ep(self) -> f64 {
        let pr_ep = f64::from(self.pr_count) * EP_PER_PR;
        let send_ep = f64::from(self.sends) * EP_PER_SEND;
        let elevation_ep = (self.elevation_m.max(0.0) / 100.0) * EP_PER_ELEVATION_100M;
        pr_ep.min(EP_PR_CAP) + send_ep.min(EP_SEND_CAP) + elevation_ep.min(EP_ELEVATION_CAP)
    }
}

impl AddAssign for EffortBonuses {
    fn add_assign(&mut self, rhs: Self) {
        self.pr_count += rhs.pr_count;
        self.sends += rhs.sends;
        self.elevation_m += rhs.elevation_m;
    }
}

/// Effort Points for one session, before the daily cap.
///
/// Minutes below zero are treated as zero. Bonuses are individually bounded;
/// the aggregate daily cap is applied by [`effort_points_daily`].
pub fn effort_points(minutes: f64, discipline: Discipline, bonuses: &EffortBonuses) -> f64 {
    let base = minutes.max(0.0) * discipline.intensity();
    base + bonuses.ep()
}

/// Sum a day's sessions and apply the 100 EP daily cap.
pub fn effort_points_daily(sessions: &[SessionEffort]) -> f64 {
    let total: f64 = sessions
        .iter()
        .map(|session| effort_points(session.minutes, session.discipline, &session.bonuses))
        .sum();
    total.min(DAILY_EP_CAP)
}

#[cfg(test)]
mod tests {
    use super::{
        effort_points, effort_points_daily, Discipline, EffortBonuses, SessionEffort, DAILY_EP_CAP,
    };

    fn assert_approx(actual: f64, expected: f64) {
        let tolerance = 1e-9;
        assert!(
            (actual - expected).abs() < tolerance,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn discipline_intensities() {
        assert_eq!(Discipline::Strength.intensity(), 1.0);
        assert_eq!(Discipline::Climbing.intensity(), 1.1);
        assert_eq!(Discipline::Cycling.intensity(), 0.9);
    }

    #[test]
    fn plain_session_points() {
        let none = EffortBonuses::default();
        assert_approx(effort_points(60.0, Discipline::Strength, &none), 60.0);
        assert_approx(effort_points(45.0, Discipline::Climbing, &none), 49.5);
        assert_approx(effort_points(90.0, Discipline::Cycling, &none), 81.0);
    }

    #[test]
    fn bonuses_are_bounded() {
        let bonuses = EffortBonuses {
            pr_count: 99,
            sends: 99,
            elevation_m: 10_000.0,
        };
        // 10 (PR) + 10 (sends) + 15 (elevation) = 35 bonus EP.
        assert_approx(
            effort_points(30.0, Discipline::Climbing, &bonuses),
            33.0 + 35.0,
        );
    }

    #[test]
    fn mixed_session_points() {
        let bonuses = EffortBonuses {
            pr_count: 2,
            sends: 5,
            elevation_m: 250.0,
        };
        // 30 min climbing = 33, + 4 (PR) + 5 (sends) + 2.5 (elevation).
        assert_approx(effort_points(30.0, Discipline::Climbing, &bonuses), 44.5);
    }

    #[test]
    fn daily_cap_applies() {
        let sessions = [
            SessionEffort {
                minutes: 100.0,
                discipline: Discipline::Strength,
                bonuses: EffortBonuses::default(),
            },
            SessionEffort {
                minutes: 100.0,
                discipline: Discipline::Strength,
                bonuses: EffortBonuses::default(),
            },
        ];
        assert_eq!(effort_points_daily(&sessions), DAILY_EP_CAP);
    }

    #[test]
    fn daily_total_below_cap_is_untouched() {
        let sessions = [SessionEffort {
            minutes: 40.0,
            discipline: Discipline::Cycling,
            bonuses: EffortBonuses::default(),
        }];
        assert_approx(effort_points_daily(&sessions), 36.0);
    }

    #[test]
    fn negative_minutes_are_clamped() {
        let none = EffortBonuses::default();
        assert_eq!(effort_points(-10.0, Discipline::Strength, &none), 0.0);
    }
}
