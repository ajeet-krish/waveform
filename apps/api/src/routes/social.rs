//! Social surface: leaderboard boards, heatmap, feed, kudos, and groups.
//! Phase 3 adds the read endpoints and kudos mutations; this module only
//! reserves the namespace.

use axum::Router;

/// Router for the social surface. Empty until handlers land in phase 3.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
}
