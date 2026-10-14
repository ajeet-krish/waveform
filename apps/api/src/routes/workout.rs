//! Workout surface: sessions, exercise entries, set entries, routines, and
//! custom exercises. Phase 1 adds the JSON CRUD endpoints; this module only
//! reserves the namespace.

use axum::Router;

/// Router for the workout surface. Empty until handlers land in phase 1.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
}
