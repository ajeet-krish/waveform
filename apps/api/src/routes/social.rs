//! Social surface: the read-only leaderboard boards.
//!
//! `GET /social/boards?window=` aggregates the implicit friend crew (every
//! non-tombstoned user) over one trailing window and returns the ranked
//! boards from the locked scoring ADR (docs/decisions.md 2026-10-14):
//! Consistency, lifting (volume, best e1RM per marquee lift, relative
//! e1RM), cycling (distance, elevation), and climbing (V-points, hardest
//! grade). Ties share rank (1, 2, 2, 4).
//!
//! Privacy is binding: no response carries a `body_stats` column or an
//! email. Bodyweight is read only to divide out the relative-e1RM ratio
//! server-side, and members are identified by [`PublicUser`] alone. The
//! relative ratio is rounded to two decimals before ranking, so the
//! published absolute board cannot be divided by it to recover the exact
//! bodyweight (docs/decisions.md 2026-10-16).

use std::collections::HashMap;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, Utc};
use serde::Deserialize;
use uuid::Uuid;

use waveform_analytics::boards::{
    climbing_board, consistency_board, marquee_lift_alias_pairs, metric_board, relative_e1rm_board,
    ClimbingInput, ConsistencyInput, RelativeE1rmInput, MARQUEE_LIFTS,
};
use waveform_db::dto::{
    BoardWindow, BoardsResponse, ClimbingBoardEntry, ConsistencyBoardEntry, CyclingBoards,
    CyclingDistanceEntry, CyclingElevationEntry, LiftingBoards, LiftingVolumeEntry,
    MarqueeLiftBoard, MarqueeLiftEntry, RelativeE1rmEntry,
};
use waveform_db::models::PublicUser;
use waveform_db::queries::boards as board_queries;

use crate::error::ApiError;
use crate::extractors::{ApiQuery, AuthUser};
use crate::state::AppState;

/// Router for the social surface.
pub fn router() -> Router<AppState> {
    Router::new().route("/social/boards", get(boards))
}

/// `GET /social/boards` query parameters.
#[derive(Debug, Deserialize)]
pub struct BoardsQuery {
    /// Window selector (`7d`, `4w`, `12w`); absent means `7d`.
    pub window: Option<String>,
}

/// `GET /social/boards`: every ranked board for one window. Unknown
/// windows answer 400; the boards always cover the whole crew, with zero
/// values for members that have no data in the window.
async fn boards(
    State(state): State<AppState>,
    _auth: AuthUser,
    ApiQuery(query): ApiQuery<BoardsQuery>,
) -> Result<Json<BoardsResponse>, ApiError> {
    let window = match query.window.as_deref() {
        None => BoardWindow::Days7,
        Some(raw) => BoardWindow::parse(raw)
            .ok_or_else(|| ApiError::BadRequest("unknown board window".to_owned()))?,
    };

    // The window ends today (server date) and is inclusive, so `7d` covers
    // seven calendar days.
    let end = Utc::now().date_naive();
    let start = end - Duration::days(window.days() - 1);

    let crew = board_queries::crew(&state.pool).await?;
    let active = board_queries::active_days(&state.pool, start, end).await?;
    let weekly = board_queries::weekly_active_days(&state.pool, start, end).await?;
    let volume = board_queries::lifting_volume(&state.pool, start, end).await?;
    let (lift_aliases, lift_canonicals) = marquee_lift_alias_pairs();
    let marquee =
        board_queries::marquee_best_e1rm(&state.pool, start, end, &lift_aliases, &lift_canonicals)
            .await?;
    // Owner-private: consumed below only to divide out the relative ratio.
    let bodyweight = board_queries::latest_bodyweight(&state.pool, end).await?;
    let cycling = board_queries::cycling_totals(&state.pool, start, end).await?;
    let climbing = board_queries::climbing_sends(&state.pool, start, end).await?;

    let by_id: HashMap<Uuid, PublicUser> =
        crew.iter().map(|user| (user.id, user.clone())).collect();

    let consistency = consistency_entries(&crew, active, weekly, &by_id);
    let lifting = lifting_boards(&crew, volume, marquee, bodyweight, &by_id);
    let cycling = cycling_boards(&crew, cycling, &by_id);
    let climbing = climbing_entries(&crew, climbing, &by_id);

    Ok(Json(BoardsResponse {
        window,
        marquee_lifts: MARQUEE_LIFTS
            .iter()
            .map(|lift| (*lift).to_owned())
            .collect(),
        consistency,
        lifting,
        cycling,
        climbing,
    }))
}

/// Consistency board: active days in the window, tie-broken by the weekly
/// streak. Every crew member appears, at zero when inactive.
fn consistency_entries(
    crew: &[PublicUser],
    active: Vec<(Uuid, i32)>,
    weekly: Vec<(Uuid, NaiveDate, i32)>,
    by_id: &HashMap<Uuid, PublicUser>,
) -> Vec<ConsistencyBoardEntry> {
    let active_by_user: HashMap<Uuid, i32> = active.into_iter().collect();
    let mut weekly_by_user: HashMap<Uuid, Vec<(NaiveDate, i32)>> = HashMap::new();
    for (user_id, week_start, count) in weekly {
        weekly_by_user
            .entry(user_id)
            .or_default()
            .push((week_start, count));
    }

    let inputs: Vec<ConsistencyInput<Uuid>> = crew
        .iter()
        .map(|user| ConsistencyInput {
            member: user.id,
            active_days: active_by_user.get(&user.id).copied().unwrap_or(0),
            weekly_active_days: weekly_by_user.remove(&user.id).unwrap_or_default(),
        })
        .collect();

    consistency_board(&inputs)
        .into_iter()
        .filter_map(|entry| {
            by_id.get(&entry.member).map(|user| ConsistencyBoardEntry {
                rank: entry.rank,
                user: user.clone(),
                active_days: entry.active_days,
                weekly_streak: entry.weekly_streak,
            })
        })
        .collect()
}

/// The lifting discipline's three boards.
fn lifting_boards(
    crew: &[PublicUser],
    volume: Vec<(Uuid, f64)>,
    marquee: Vec<(Uuid, String, f64)>,
    bodyweight: Vec<(Uuid, f64)>,
    by_id: &HashMap<Uuid, PublicUser>,
) -> LiftingBoards {
    let volume_by_user: HashMap<Uuid, f64> = volume.into_iter().collect();
    let volume_inputs: Vec<(Uuid, f64)> = crew
        .iter()
        .map(|user| {
            (
                user.id,
                volume_by_user.get(&user.id).copied().unwrap_or(0.0),
            )
        })
        .collect();
    let volume_entries = metric_board(&volume_inputs)
        .into_iter()
        .filter_map(|entry| {
            by_id.get(&entry.member).map(|user| LiftingVolumeEntry {
                rank: entry.rank,
                user: user.clone(),
                volume_kg: entry.value,
            })
        })
        .collect();

    let mut best_by_lift_user: HashMap<(String, Uuid), f64> = HashMap::new();
    for (user_id, lift, best) in marquee {
        best_by_lift_user.insert((lift, user_id), best);
    }
    let e1rm: Vec<MarqueeLiftBoard> = MARQUEE_LIFTS
        .iter()
        .map(|&lift| {
            let inputs: Vec<(Uuid, f64)> = crew
                .iter()
                .map(|user| {
                    (
                        user.id,
                        best_by_lift_user
                            .get(&(lift.to_owned(), user.id))
                            .copied()
                            .unwrap_or(0.0),
                    )
                })
                .collect();
            let entries = metric_board(&inputs)
                .into_iter()
                .filter_map(|entry| {
                    by_id.get(&entry.member).map(|user| MarqueeLiftEntry {
                        rank: entry.rank,
                        user: user.clone(),
                        best_e1rm_kg: entry.value,
                    })
                })
                .collect();
            MarqueeLiftBoard {
                lift: lift.to_owned(),
                entries,
            }
        })
        .collect();

    // The relative board uses the member's best e1RM across the marquee
    // lifts, divided by bodyweight. Members with no marquee lift or no
    // bodyweight are left off.
    let mut best_by_user: HashMap<Uuid, f64> = HashMap::new();
    for ((_, user_id), best) in &best_by_lift_user {
        best_by_user
            .entry(*user_id)
            .and_modify(|current| *current = current.max(*best))
            .or_insert(*best);
    }
    let bodyweight_by_user: HashMap<Uuid, f64> = bodyweight.into_iter().collect();
    let relative_inputs: Vec<RelativeE1rmInput<Uuid>> = crew
        .iter()
        .filter_map(|user| {
            let best = best_by_user.get(&user.id).copied()?;
            if best <= 0.0 {
                return None;
            }
            let weight = bodyweight_by_user.get(&user.id).copied()?;
            Some(RelativeE1rmInput {
                member: user.id,
                best_e1rm_kg: best,
                bodyweight_kg: weight,
            })
        })
        .collect();
    let relative_e1rm = relative_e1rm_board(&relative_inputs)
        .into_iter()
        .filter_map(|entry| {
            by_id.get(&entry.member).map(|user| RelativeE1rmEntry {
                rank: entry.rank,
                user: user.clone(),
                ratio: entry.ratio,
            })
        })
        .collect();

    LiftingBoards {
        volume: volume_entries,
        e1rm,
        relative_e1rm,
    }
}

/// The cycling discipline's two boards.
fn cycling_boards(
    crew: &[PublicUser],
    cycling: Vec<(Uuid, f64, f64)>,
    by_id: &HashMap<Uuid, PublicUser>,
) -> CyclingBoards {
    let mut by_user: HashMap<Uuid, (f64, f64)> = HashMap::new();
    for (user_id, distance, elevation) in cycling {
        by_user.insert(user_id, (distance, elevation));
    }

    let distance_inputs: Vec<(Uuid, f64)> = crew
        .iter()
        .map(|user| {
            (
                user.id,
                by_user.get(&user.id).map(|totals| totals.0).unwrap_or(0.0),
            )
        })
        .collect();
    let elevation_inputs: Vec<(Uuid, f64)> = crew
        .iter()
        .map(|user| {
            (
                user.id,
                by_user.get(&user.id).map(|totals| totals.1).unwrap_or(0.0),
            )
        })
        .collect();

    let distance = metric_board(&distance_inputs)
        .into_iter()
        .filter_map(|entry| {
            by_id.get(&entry.member).map(|user| CyclingDistanceEntry {
                rank: entry.rank,
                user: user.clone(),
                distance_km: entry.value,
            })
        })
        .collect();
    let elevation = metric_board(&elevation_inputs)
        .into_iter()
        .filter_map(|entry| {
            by_id.get(&entry.member).map(|user| CyclingElevationEntry {
                rank: entry.rank,
                user: user.clone(),
                elevation_m: entry.value,
            })
        })
        .collect();

    CyclingBoards {
        distance,
        elevation,
    }
}

/// Climbing board: V-points with the hardest grade as the tie-break.
fn climbing_entries(
    crew: &[PublicUser],
    climbing: Vec<(Uuid, i32, i32)>,
    by_id: &HashMap<Uuid, PublicUser>,
) -> Vec<ClimbingBoardEntry> {
    let mut sends_by_user: HashMap<Uuid, Vec<(i32, i32)>> = HashMap::new();
    for (user_id, grade, sends) in climbing {
        sends_by_user
            .entry(user_id)
            .or_default()
            .push((grade, sends));
    }

    let inputs: Vec<ClimbingInput<Uuid>> = crew
        .iter()
        .map(|user| ClimbingInput {
            member: user.id,
            sends: sends_by_user.remove(&user.id).unwrap_or_default(),
        })
        .collect();

    climbing_board(&inputs)
        .into_iter()
        .filter_map(|entry| {
            by_id.get(&entry.member).map(|user| ClimbingBoardEntry {
                rank: entry.rank,
                user: user.clone(),
                v_points: entry.v_points,
                hardest_grade: entry.hardest_grade,
            })
        })
        .collect()
}
