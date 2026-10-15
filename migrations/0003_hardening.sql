/* Phase 0 review hardening (docs/reviews.md). Append-only: 0001 and 0002
   are never edited; everything here is additive or an explicit ALTER.

   1. Float measurement columns move from numeric(p,s) to double precision.
      SQLx 0.8 cannot decode Postgres NUMERIC into Rust f64, so every model
      field typed f64 in crates/db/src/models.rs must sit on a double
      precision column. set_entries.e1rm_kg is regenerated as double
      precision with the same Brzycki formula; the literals are cast so the
      whole expression runs in float8 and matches crates/scoring.
   2. Sync pull support. Every synced entity gains a server-set applied_at
      column plus a non-partial (owner, applied_at, id) index. The old
      partial updated_at indexes stay for live-row reads, but pull pages on
      (applied_at, id) so tombstones are included and rows that share one
      timestamp are never dropped across a page boundary.
   3. Constraint hardening: tombstone-aware kudos uniqueness, exercise
      history that survives exercise deletion, case-insensitive email
      uniqueness, expiring single-use invites, attempt-capped OTP codes
      with one live code per email, a sessions cleanup index, and range
      CHECKs on measurement columns.
   4. client_ops gains a processed_at index so the retention job can prune
      replay dedupe history. */

/* Float measurement columns to double precision. */

ALTER TABLE routine_entries
    ALTER COLUMN target_weight_kg TYPE double precision
    USING target_weight_kg::double precision;

ALTER TABLE activities
    ALTER COLUMN distance_km TYPE double precision USING distance_km::double precision,
    ALTER COLUMN elevation_m TYPE double precision USING elevation_m::double precision,
    ALTER COLUMN climb_grade_value TYPE double precision USING climb_grade_value::double precision;

ALTER TABLE body_stats
    ALTER COLUMN weight_kg TYPE double precision USING weight_kg::double precision,
    ALTER COLUMN bodyfat_pct TYPE double precision USING bodyfat_pct::double precision,
    ALTER COLUMN neck_cm TYPE double precision USING neck_cm::double precision,
    ALTER COLUMN shoulders_cm TYPE double precision USING shoulders_cm::double precision,
    ALTER COLUMN chest_cm TYPE double precision USING chest_cm::double precision,
    ALTER COLUMN bicep_cm TYPE double precision USING bicep_cm::double precision,
    ALTER COLUMN waist_cm TYPE double precision USING waist_cm::double precision,
    ALTER COLUMN hips_cm TYPE double precision USING hips_cm::double precision,
    ALTER COLUMN thigh_cm TYPE double precision USING thigh_cm::double precision,
    ALTER COLUMN calf_cm TYPE double precision USING calf_cm::double precision;

/* e1rm_kg is regenerated so the stored Brzycki expression type checks
   against the float8 weight column and can no longer overflow the old
   numeric(6,2) domain. The generated column was computed before CHECK
   validation, so an overflow aborted the insert with an opaque error.
   The literals are cast to double precision so the arithmetic matches
   crates/scoring. */
ALTER TABLE set_entries DROP COLUMN e1rm_kg;
ALTER TABLE set_entries
    ALTER COLUMN weight_kg TYPE double precision USING weight_kg::double precision;
ALTER TABLE set_entries ADD COLUMN e1rm_kg double precision GENERATED ALWAYS AS (
    CASE
        WHEN reps <= 1 THEN weight_kg
        ELSE weight_kg / (1.0278::double precision - 0.0278::double precision * reps)
    END
) STORED;

/* Server-authoritative sync pull: applied_at plus composite indexes.

   applied_at is the server-assigned sync cursor timestamp. It defaults to
   now() and a trigger forces now() again on every insert and update, so a
   payload can never pin it to a future time and starve other devices'
   pulls. Pull pages with:

     SELECT ... WHERE <owner> = $1 AND (applied_at, id) > ($2, $3)
     ORDER BY applied_at, id LIMIT <page size>;

   The id tie-break keeps rows that share one applied_at from being dropped
   across a page boundary. Client-supplied updated_at values no longer
   drive the cursor; they only decide last-write-wins and are clamped by
   the sync contract (crates/sync/src/lib.rs). */
CREATE FUNCTION stamp_applied_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.applied_at := now();
    RETURN NEW;
END;
$$;

ALTER TABLE routines ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER routines_applied_at BEFORE INSERT OR UPDATE ON routines
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE routine_entries ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER routine_entries_applied_at BEFORE INSERT OR UPDATE ON routine_entries
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE workout_sessions ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER workout_sessions_applied_at BEFORE INSERT OR UPDATE ON workout_sessions
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE exercise_entries ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER exercise_entries_applied_at BEFORE INSERT OR UPDATE ON exercise_entries
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE set_entries ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER set_entries_applied_at BEFORE INSERT OR UPDATE ON set_entries
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE activities ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER activities_applied_at BEFORE INSERT OR UPDATE ON activities
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE body_stats ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER body_stats_applied_at BEFORE INSERT OR UPDATE ON body_stats
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE kudos ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER kudos_applied_at BEFORE INSERT OR UPDATE ON kudos
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

ALTER TABLE challenges ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER challenges_applied_at BEFORE INSERT OR UPDATE ON challenges
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();

/* Sync pull indexes: non-partial so tombstones are included, ordered
   (owner, applied_at, id) so the pull predicate is an index range scan.
   Tables without a user_id of their own index on their parent; phase 1
   pulls those children through the parent row. The partial updated_at
   indexes from 0001 stay for live-row reads. */
CREATE INDEX routines_sync_idx ON routines (user_id, applied_at, id);
CREATE INDEX routine_entries_sync_idx ON routine_entries (routine_id, applied_at, id);
CREATE INDEX workout_sessions_sync_idx ON workout_sessions (user_id, applied_at, id);
CREATE INDEX exercise_entries_sync_idx ON exercise_entries (workout_id, applied_at, id);
CREATE INDEX set_entries_sync_idx ON set_entries (exercise_entry_id, applied_at, id);
CREATE INDEX activities_sync_idx ON activities (user_id, applied_at, id);
CREATE INDEX body_stats_sync_idx ON body_stats (user_id, applied_at, id);
CREATE INDEX kudos_sync_idx ON kudos (user_id, applied_at, id);
/* Challenges are cohort-wide; group-scoped pulls can filter on group_id. */
CREATE INDEX challenges_sync_idx ON challenges (applied_at, id);

/* Tombstone-aware kudos uniqueness: a soft-deleted kudos must not occupy
   the (workout, user) slot, otherwise un-kudos followed by re-kudos with a
   fresh client-generated id violates the constraint and the sync push
   fails. Any duplicate live rows are tombstoned before the index lands. */
UPDATE kudos SET deleted_at = now(), updated_at = now()
WHERE deleted_at IS NULL
  AND id NOT IN (
      SELECT DISTINCT ON (workout_id, user_id) id
      FROM kudos WHERE deleted_at IS NULL
      ORDER BY workout_id, user_id, created_at DESC
  );
ALTER TABLE kudos DROP CONSTRAINT kudos_workout_id_user_id_key;
CREATE UNIQUE INDEX kudos_workout_id_user_id_live_key
    ON kudos (workout_id, user_id) WHERE deleted_at IS NULL;

/* Workout history outlives the exercise catalog: a hard delete of an
   exercise must not destroy its entries, so the foreign key becomes
   RESTRICT. Catalog rows are soft-deleted through deleted_at. */
ALTER TABLE exercise_entries DROP CONSTRAINT exercise_entries_exercise_id_fkey;
ALTER TABLE exercise_entries ADD CONSTRAINT exercise_entries_exercise_id_fkey
    FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE RESTRICT;

/* Case-insensitive email uniqueness; the plain UNIQUE constraint treated
   Foo@x.com and foo@x.com as different accounts, and OTP lookups keyed by
   exact string then behaved differently per casing. Application queries
   should compare lower(email). Existing case-variant duplicate accounts
   are not deduplicated automatically; resolve them by hand if this ever
   fails on a database that already has data. */
ALTER TABLE users DROP CONSTRAINT users_email_key;
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

/* Invites expire and are redeemed atomically single-use. Redemption runs
   inside the signup transaction:

     UPDATE invites SET used_by = $2 WHERE id = $1 AND used_by IS NULL;

   zero rows updated means the code was already redeemed (HTTP 409). When
   invites.email is set, signup must create the account with a
   case-insensitive match on that address (HTTP 403 otherwise). */
UPDATE invites SET expires_at = created_at + interval '30 days'
WHERE expires_at IS NULL;
ALTER TABLE invites ALTER COLUMN expires_at SET NOT NULL;

/* One live (unconsumed) code per email. Issuing a new code supersedes the
   old one inside the send transaction:

     UPDATE otp_codes SET consumed_at = now()
     WHERE email = $1 AND consumed_at IS NULL;

   then the new code is inserted. The partial unique index keeps at most
   one unconsumed code per email, and verification must increment attempts
   atomically (UPDATE ... RETURNING) so concurrent verifies cannot beat
   the attempt cap. */

/* Supersede any leftover live codes before the index lands. */
UPDATE otp_codes SET consumed_at = now()
WHERE consumed_at IS NULL
  AND id NOT IN (
      SELECT DISTINCT ON (email) id
      FROM otp_codes WHERE consumed_at IS NULL
      ORDER BY email, created_at DESC
  );
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_attempts_cap CHECK (attempts <= 5);
CREATE UNIQUE INDEX otp_codes_live_email_key ON otp_codes (email)
    WHERE consumed_at IS NULL;

/* The session cleanup job deletes rows past expires_at. */
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

/* Measurement ranges. NULL passes a CHECK, so each guard is written
   explicitly. Set weights allow 0 for bodyweight and banded work; body
   and target weights must be positive; nothing plausibly human exceeds
   1500 kg. Durations are whole minutes within one calendar day. */
ALTER TABLE set_entries DROP CONSTRAINT set_entries_weight_kg_check;
ALTER TABLE set_entries ADD CONSTRAINT set_entries_weight_kg_range
    CHECK (weight_kg >= 0 AND weight_kg <= 1500);
ALTER TABLE body_stats ADD CONSTRAINT body_stats_weight_kg_range
    CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg <= 1500));
ALTER TABLE body_stats ADD CONSTRAINT body_stats_bodyfat_pct_range
    CHECK (bodyfat_pct IS NULL OR (bodyfat_pct >= 0 AND bodyfat_pct <= 100));
ALTER TABLE routine_entries ADD CONSTRAINT routine_entries_target_weight_kg_range
    CHECK (target_weight_kg IS NULL OR (target_weight_kg > 0 AND target_weight_kg <= 1500));
ALTER TABLE activities ADD CONSTRAINT activities_climb_grade_value_range
    CHECK (climb_grade_value IS NULL OR (climb_grade_value >= 0 AND climb_grade_value <= 16));
ALTER TABLE activities ADD CONSTRAINT activities_routes_sent_range
    CHECK (routes_sent IS NULL OR routes_sent >= 0);
ALTER TABLE activities ADD CONSTRAINT activities_duration_min_range
    CHECK (duration_min IS NULL OR (duration_min >= 0 AND duration_min <= 1440));
ALTER TABLE workout_sessions ADD CONSTRAINT workout_sessions_duration_min_range
    CHECK (duration_min IS NULL OR (duration_min >= 0 AND duration_min <= 1440));

/* client_ops retention: push handlers stamp processed_at when an op is
   acknowledged, and a scheduled job prunes rows older than the maximum
   offline window (for example 30 days). */
CREATE INDEX client_ops_processed_at_idx ON client_ops (processed_at)
    WHERE processed_at IS NOT NULL;
