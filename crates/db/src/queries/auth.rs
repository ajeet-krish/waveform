//! Auth queries: `users` rows and opaque bearer sessions.
//!
//! Lookups compare `lower(email)` (the `users_email_lower_key` unique
//! index from `migrations/0003_hardening.sql`), soft-deleted users never
//! resolve, and sessions are addressed only by their stored
//! `sessions.token_hash`; the raw token never reaches this crate.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::{Session, User};

/// Every `users` column the [`User`] model decodes; `FromRow` requires
/// the full set, so queries must never project fewer.
const USER_COLUMNS: &str = "id, email, display_name, password_hash, github_id, avatar_url, \
                            created_at, updated_at, deleted_at";

/// Failure modes of [`create_user`].
#[derive(Debug)]
pub enum InsertError {
    /// `users_email_lower_key` (or the original `users_email_key`)
    /// unique violation: the address is taken, in any casing.
    DuplicateEmail,
    /// Any other database failure (connection trouble, statement
    /// timeout, other constraint violations).
    Database(sqlx::Error),
}

impl std::fmt::Display for InsertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InsertError::DuplicateEmail => write!(f, "email already registered"),
            InsertError::Database(error) => write!(f, "database error during user insert: {error}"),
        }
    }
}

impl std::error::Error for InsertError {}

impl From<sqlx::Error> for InsertError {
    fn from(error: sqlx::Error) -> Self {
        InsertError::Database(error)
    }
}

/// Classify an insert failure: a unique violation on an email index is
/// [`InsertError::DuplicateEmail`], everything else stays a database
/// error.
fn classify_insert(error: sqlx::Error) -> InsertError {
    if let sqlx::Error::Database(ref database) = error {
        if database.is_unique_violation() {
            if let Some(constraint) = database.constraint() {
                if constraint == "users_email_lower_key" || constraint == "users_email_key" {
                    return InsertError::DuplicateEmail;
                }
            }
        }
    }
    InsertError::Database(error)
}

/// Insert an email + password account and return the created row.
pub async fn create_user(
    pool: &PgPool,
    email: &str,
    display_name: &str,
    password_hash: &str,
) -> Result<User, InsertError> {
    let id = Uuid::new_v4();
    let sql = format!(
        "INSERT INTO users (id, email, display_name, password_hash) \
         VALUES ($1, $2, $3, $4) RETURNING {USER_COLUMNS}"
    );
    sqlx::query_as::<_, User>(&sql)
        .bind(id)
        .bind(email)
        .bind(display_name)
        .bind(password_hash)
        .fetch_one(pool)
        .await
        .map_err(classify_insert)
}

/// Find a live (non-tombstoned) user by email, case-insensitively.
pub async fn find_user_by_email(pool: &PgPool, email: &str) -> Result<Option<User>, sqlx::Error> {
    let sql = format!(
        "SELECT {USER_COLUMNS} FROM users \
         WHERE lower(email) = lower($1) AND deleted_at IS NULL"
    );
    sqlx::query_as::<_, User>(&sql)
        .bind(email)
        .fetch_optional(pool)
        .await
}

/// Find a live (non-tombstoned) user by id.
pub async fn find_user_by_id(pool: &PgPool, user_id: Uuid) -> Result<Option<User>, sqlx::Error> {
    let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL");
    sqlx::query_as::<_, User>(&sql)
        .bind(user_id)
        .fetch_optional(pool)
        .await
}

/// Store a session's token hash with its expiry and return the row.
pub async fn create_session(
    pool: &PgPool,
    user_id: Uuid,
    token_hash: &str,
    expires_at: DateTime<Utc>,
) -> Result<Session, sqlx::Error> {
    let id = Uuid::new_v4();
    sqlx::query_as::<_, Session>(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, $4) \
         RETURNING id, user_id, token_hash, created_at, expires_at",
    )
    .bind(id)
    .bind(user_id)
    .bind(token_hash)
    .bind(expires_at)
    .fetch_one(pool)
    .await
}

/// Resolve a session token hash to its live user: the session must not
/// be expired and the user must not be tombstoned.
pub async fn find_user_by_session_token_hash(
    pool: &PgPool,
    token_hash: &str,
) -> Result<Option<User>, sqlx::Error> {
    // `users.*` carries the full column set the [`User`] model decodes,
    // whatever the alias-free names come back as.
    sqlx::query_as::<_, User>(
        "SELECT users.* FROM sessions \
         JOIN users ON users.id = sessions.user_id \
         WHERE sessions.token_hash = $1 \
           AND sessions.expires_at > now() \
           AND users.deleted_at IS NULL",
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await
}

/// Delete one session by its token hash; the number of deleted rows
/// reports whether anything was revoked (0 makes logout idempotent).
pub async fn delete_session_by_token_hash(
    pool: &PgPool,
    token_hash: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(token_hash)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Remove every session past its expiry (best-effort housekeeping run
/// after successful logins).
pub async fn purge_expired_sessions(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at <= now()")
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}
