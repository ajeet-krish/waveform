//! `users.password_hash` groundwork for email + password accounts
//! (ADR 2026-10-15): the column exists and is nullable (Argon2id PHC
//! strings land in bucket 2; login rejects NULL), the `User` model
//! round-trips it through the database, and serialization never lets it
//! reach a JSON response or the generated TypeScript.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-db --test password_hash
//! ```

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use waveform_db::User;

const PHC_HASH: &str = "$argon2id$v=19$m=19456,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2g=";

fn base_url() -> Option<String> {
    std::env::var("WAVEFORM_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .filter(|url| !url.is_empty())
}

fn with_database(base_url: &str, database: &str) -> String {
    let (prefix, _) = base_url
        .rsplit_once('/')
        .expect("url needs a database path");
    format!("{prefix}/{database}")
}

struct ScratchDb {
    pool: PgPool,
    base_url: String,
    name: String,
}

async fn scratch() -> Option<ScratchDb> {
    let base_url = base_url()?;
    let name = format!("waveform_test_{}", Uuid::new_v4().simple());
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&with_database(&base_url, "postgres"))
        .await
        .expect("connect to maintenance database");
    sqlx::query(&format!(r#"CREATE DATABASE "{name}""#))
        .execute(&admin)
        .await
        .expect("create scratch database");
    admin.close().await;

    let pool = waveform_db::connect(&with_database(&base_url, &name))
        .await
        .expect("connect to scratch database");
    Some(ScratchDb {
        pool,
        base_url,
        name,
    })
}

async fn drop_scratch(db: ScratchDb) {
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&with_database(&db.base_url, "postgres"))
        .await
        .expect("reconnect to maintenance database");
    sqlx::query(&format!(
        r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#,
        db.name
    ))
    .execute(&admin)
    .await
    .expect("drop scratch database");
    admin.close().await;
}

macro_rules! skip_without_db {
    () => {
        match scratch().await {
            Some(db) => {
                waveform_db::run_migrations(&db.pool)
                    .await
                    .expect("migrations must apply to a fresh database");
                db
            }
            None => {
                eprintln!(
                    "SKIPPED: set WAVEFORM_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres \
                     URL with CREATE DATABASE rights to run password hash tests"
                );
                return;
            }
        }
    };
}

#[tokio::test]
async fn password_hash_column_exists_and_is_nullable() {
    let db = skip_without_db!();

    let (data_type, is_nullable): (String, String) = sqlx::query_as(
        "SELECT data_type, is_nullable FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'users' \
           AND column_name = 'password_hash'",
    )
    .fetch_one(&db.pool)
    .await
    .expect("password_hash column must exist");
    assert_eq!(data_type, "text");
    assert_eq!(
        is_nullable, "YES",
        "NULL means the account cannot log in yet"
    );

    // A user row without a hash inserts cleanly (nullable, no default
    // that could fake a hash).
    let bare_id = Uuid::new_v4();
    let inserted =
        sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'No Hash')")
            .bind(bare_id)
            .bind(format!("bare-{}@test.invalid", bare_id.simple()))
            .execute(&db.pool)
            .await;
    assert!(inserted.is_ok(), "a NULL password_hash must be allowed");
    let stored: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(bare_id)
            .fetch_one(&db.pool)
            .await
            .expect("read back");
    assert_eq!(stored, None);

    drop_scratch(db).await;
}

#[tokio::test]
async fn user_round_trips_with_a_hash_but_never_serializes_it() {
    let db = skip_without_db!();
    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(format!("hash-{}@test.invalid", id.simple()))
    .bind("Hash Tester")
    .bind(PHC_HASH)
    .execute(&db.pool)
    .await
    .expect("insert user with hash");

    // Decode through an explicit column list that includes the hash, the
    // shape any auth query will use in bucket 2.
    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, display_name, password_hash, github_id, avatar_url, \
                created_at, updated_at, deleted_at \
         FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .expect("decode User");
    assert_eq!(user.password_hash.as_deref(), Some(PHC_HASH));
    assert_eq!(
        user.email,
        format!("hash-{id}@test.invalid", id = id.simple())
    );

    // serde must skip the hash: the JSON response body carries no trace.
    let json = serde_json::to_value(&user).expect("serialize User");
    let object = json.as_object().expect("User serializes to an object");
    assert!(
        !object.contains_key("password_hash"),
        "password_hash must never reach a JSON response: {json}"
    );
    assert_eq!(
        object.get("email").and_then(|v| v.as_str()),
        Some(user.email.as_str()),
        "the rest of the user still serializes"
    );

    // Deserializing a wire body (which never carried the field) yields a
    // User with no hash rather than a decode error.
    let decoded: User = serde_json::from_value(json).expect("deserialize User");
    assert_eq!(decoded.password_hash, None);
    assert_eq!(decoded.id, user.id);

    drop_scratch(db).await;
}

#[tokio::test]
async fn generated_typescript_user_type_has_no_password_hash() {
    // The wire type is the fence: if #[ts(skip)] ever drifts, the
    // committed generated.ts gains a password_hash field and this test
    // says so before CI's drift check does.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/api-types/src/generated.ts");
    let source = std::fs::read_to_string(&path).expect("read generated.ts");
    let start = source
        .find("export type User = ")
        .expect("User type must be exported");
    // The User definition ends at its first "};" after the header; the
    // following types start with a doc comment or export keyword.
    let rest = &source[start..];
    let end = rest.find("};").expect("User type must be terminated") + "};".len();
    let definition = &rest[..end];
    assert!(
        !definition.contains("password_hash"),
        "generated User must not gain password_hash: {definition}"
    );
}
