//! Activity surface: cycling, climbing, running, hike, and swim entries
//! with distance, elevation, and grade. Phase 2 adds the CRUD endpoints;
//! this module only reserves the namespace.

use axum::Router;

/// Router for the activity surface. Empty until handlers land in phase 2.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
}
