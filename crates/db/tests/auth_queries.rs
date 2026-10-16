//! Auth query integration tests against a real Postgres.
//!
//! Covers the contract `routes/auth.rs` relies on: case-insensitive
//! email uniqueness and lookup, tombstoned users that stop resolving,
//! session create/lookup/delete round trips, expired sessions that never
//! resolve, and a purge that touches only expired rows.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g.
//! the compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-db --test auth_queries
//! ```
//!
//! Without the env var every test prints a skip notice and returns.

use chrono::{Duration, Utc};
use uuid::Uuid;

use waveform_db::models::User;
use waveform_db::queries::{
    create_session, create_user, delete_session_by_token_hash, find_user_by_email, find_user_by_id,
    find_user_by_session_token_hash, purge_expired_sessions, InsertError,
};

mod support;

/// A syntactically valid Argon2id PHC string; these queries store the
/// hash opaquely, so no verification happens here.
const PHC_HASH: &str =
    "$argon2id$v=19$m=19456,t=3,p=1$eDUwdmhZTFVVRGJ0NHFUdw$QnpxbEZ3T3BZNEQvbU5IckNnTDF2ZyI";

fn live_user_email(base: &str) -> String {
    format!("{base}@queries.test")
}

#[tokio::test]
async fn duplicate_emails_collide_regardless_of_case() {
    let Some(db) = support::migrated_scratch("duplicate emails").await else {
        return;
    };

    let email = live_user_email("Taken");
    create_user(&db.pool, &email, "First", PHC_HASH)
        .await
        .expect("first signup lands");

    let duplicate = create_user(&db.pool, &email.to_lowercase(), "Second", PHC_HASH).await;
    assert!(
        matches!(duplicate, Err(InsertError::DuplicateEmail)),
        "a case-variant duplicate must be DuplicateEmail, got {duplicate:?}"
    );

    // A genuinely new address still lands in the same database.
    let fresh = create_user(&db.pool, &live_user_email("Free"), "Third", PHC_HASH).await;
    assert!(fresh.is_ok(), "a new address must not collide");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn email_lookup_is_case_insensitive_and_skips_deleted() {
    let Some(db) = support::migrated_scratch("email lookup").await else {
        return;
    };

    let email = live_user_email("Lookup");
    let created = create_user(&db.pool, &email, "Lookup", PHC_HASH)
        .await
        .expect("create user");

    let found = find_user_by_email(&db.pool, &email.to_uppercase())
        .await
        .expect("lookup")
        .expect("live user resolves case-insensitively");
    assert_eq!(found.id, created.id);
    assert_eq!(found.email, email, "the stored casing is preserved");

    // Soft delete: the row survives, the lookups stop resolving.
    sqlx::query("UPDATE users SET deleted_at = now() WHERE id = $1")
        .bind(created.id)
        .execute(&db.pool)
        .await
        .expect("tombstone user");

    let after_delete = find_user_by_email(&db.pool, &email).await.expect("lookup");
    assert!(after_delete.is_none(), "tombstoned users must not resolve");
    let by_id = find_user_by_id(&db.pool, created.id)
        .await
        .expect("lookup by id");
    assert!(by_id.is_none(), "find_user_by_id must skip deleted too");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn session_create_lookup_and_delete_round_trip() {
    let Some(db) = support::migrated_scratch("session round trip").await else {
        return;
    };

    let user = create_user(&db.pool, &live_user_email("Session"), "Session", PHC_HASH)
        .await
        .expect("create user");
    let token_hash = "0123456789abcdef".repeat(4);
    let expires_at = Utc::now() + Duration::days(30);
    let session = create_session(&db.pool, user.id, &token_hash, expires_at)
        .await
        .expect("create session");
    assert_eq!(session.user_id, user.id);
    assert_eq!(session.token_hash, token_hash);

    let resolved = find_user_by_session_token_hash(&db.pool, &token_hash)
        .await
        .expect("lookup")
        .expect("a live session resolves its user");
    assert_eq!(resolved.id, user.id);
    assert_eq!(resolved.password_hash.as_deref(), Some(PHC_HASH));

    let deleted = delete_session_by_token_hash(&db.pool, &token_hash)
        .await
        .expect("delete");
    assert_eq!(deleted, 1, "the session row is removed");
    let after = find_user_by_session_token_hash(&db.pool, &token_hash)
        .await
        .expect("lookup");
    assert!(after.is_none(), "a revoked session must not resolve");
    let again = delete_session_by_token_hash(&db.pool, &token_hash)
        .await
        .expect("second delete");
    assert_eq!(again, 0, "deleting twice is a no-op");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn expired_sessions_do_not_resolve() {
    let Some(db) = support::migrated_scratch("expired session").await else {
        return;
    };

    let user = create_user(&db.pool, &live_user_email("Expired"), "Expired", PHC_HASH)
        .await
        .expect("create user");
    let token_hash = Uuid::new_v4().simple().to_string();
    let past = Utc::now() - Duration::days(1);
    create_session(&db.pool, user.id, &token_hash, past)
        .await
        .expect("create expired session");

    let resolved = find_user_by_session_token_hash(&db.pool, &token_hash)
        .await
        .expect("lookup");
    assert!(resolved.is_none(), "an expired session must not resolve");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn purge_removes_only_expired_sessions() {
    let Some(db) = support::migrated_scratch("purge").await else {
        return;
    };

    let user = create_user(&db.pool, &live_user_email("Purge"), "Purge", PHC_HASH)
        .await
        .expect("create user");
    let expired_hash = Uuid::new_v4().simple().to_string();
    let live_hash = Uuid::new_v4().simple().to_string();
    create_session(
        &db.pool,
        user.id,
        &expired_hash,
        Utc::now() - Duration::hours(1),
    )
    .await
    .expect("create expired session");
    create_session(
        &db.pool,
        user.id,
        &live_hash,
        Utc::now() + Duration::days(30),
    )
    .await
    .expect("create live session");

    let purged = purge_expired_sessions(&db.pool).await.expect("purge");
    assert_eq!(purged, 1, "only the expired row is removed");

    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&db.pool)
        .await
        .expect("count sessions");
    assert_eq!(remaining, 1, "the live session survives");
    let live = find_user_by_session_token_hash(&db.pool, &live_hash)
        .await
        .expect("lookup")
        .expect("the live session still resolves");
    assert_eq!(live.id, user.id);

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn session_lookup_skips_tombstoned_users() {
    let Some(db) = support::migrated_scratch("tombstoned session owner").await else {
        return;
    };

    let user: User = create_user(&db.pool, &live_user_email("Ghost"), "Ghost", PHC_HASH)
        .await
        .expect("create user");
    let token_hash = Uuid::new_v4().simple().to_string();
    create_session(
        &db.pool,
        user.id,
        &token_hash,
        Utc::now() + Duration::days(30),
    )
    .await
    .expect("create session");

    sqlx::query("UPDATE users SET deleted_at = now() WHERE id = $1")
        .bind(user.id)
        .execute(&db.pool)
        .await
        .expect("tombstone user");

    let resolved = find_user_by_session_token_hash(&db.pool, &token_hash)
        .await
        .expect("lookup");
    assert!(
        resolved.is_none(),
        "a live session must not resurrect a tombstoned user"
    );

    support::drop_scratch(db).await;
}
