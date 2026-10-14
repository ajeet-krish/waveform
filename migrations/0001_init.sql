/* LiftLog initial schema.

   Conventions (docs/architecture.md):
   - Client-generated UUID primary keys so offline creates never collide.
   - updated_at plus a deleted_at tombstone on every synced row.
   - Weights in kg, lengths in cm; local_date is the device-local calendar day.
   - Mondays start weeks; (user_id, local_date) and partial updated_at indexes
     serve leaderboard, heatmap, and sync-pull queries.
   - set_entries.e1rm_kg is a stored generated column using the Brzycki
     formula, matching crates/scoring. */

CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    display_name text NOT NULL,
    github_id text UNIQUE,
    avatar_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    /* sha256 of the opaque session token; the raw token never hits the DB */
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE otp_codes (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    /* Argon2id hash of the 6-digit code */
    code_hash text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX otp_codes_email_idx ON otp_codes (email, created_at DESC);

CREATE TABLE invites (
    id uuid PRIMARY KEY,
    code_hash text NOT NULL UNIQUE,
    email text,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_by uuid REFERENCES users(id) ON DELETE SET NULL,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invites_used_by_idx ON invites (used_by);

CREATE TABLE groups (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE TABLE group_members (
    group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_user_id_idx ON group_members (user_id);

CREATE TABLE exercises (
    id uuid PRIMARY KEY,
    /* NULL means a global catalog row visible to every user */
    owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    muscle_group text NOT NULL,
    equipment text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX exercises_owner_id_idx ON exercises (owner_id);
CREATE UNIQUE INDEX exercises_global_name_key ON exercises (lower(name)) WHERE owner_id IS NULL;

CREATE TABLE routines (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX routines_user_id_idx ON routines (user_id);
CREATE INDEX routines_updated_at_idx ON routines (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE routine_entries (
    id uuid PRIMARY KEY,
    routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    exercise_id uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    order_index integer NOT NULL DEFAULT 0,
    target_sets integer NOT NULL DEFAULT 3,
    target_reps integer NOT NULL DEFAULT 8,
    target_weight_kg numeric(6,2),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX routine_entries_routine_id_idx ON routine_entries (routine_id);
CREATE INDEX routine_entries_updated_at_idx ON routine_entries (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE workout_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_date date NOT NULL,
    started_at timestamptz,
    duration_min integer,
    routine_id uuid REFERENCES routines(id) ON DELETE SET NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX workout_sessions_user_local_date_idx ON workout_sessions (user_id, local_date);
CREATE INDEX workout_sessions_updated_at_idx ON workout_sessions (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE exercise_entries (
    id uuid PRIMARY KEY,
    workout_id uuid NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    exercise_id uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    order_index integer NOT NULL DEFAULT 0,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX exercise_entries_workout_id_idx ON exercise_entries (workout_id);
CREATE INDEX exercise_entries_updated_at_idx ON exercise_entries (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE set_entries (
    id uuid PRIMARY KEY,
    exercise_entry_id uuid NOT NULL REFERENCES exercise_entries(id) ON DELETE CASCADE,
    set_index integer NOT NULL DEFAULT 0,
    weight_kg numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight_kg >= 0),
    reps integer NOT NULL CHECK (reps BETWEEN 1 AND 36),
    is_warmup boolean NOT NULL DEFAULT false,
    /* Brzycki e1RM: w / (1.0278 - 0.0278 * reps), matching crates/scoring */
    e1rm_kg numeric(6,2) GENERATED ALWAYS AS (
        CASE
            WHEN reps <= 1 THEN weight_kg
            ELSE weight_kg / (1.0278 - 0.0278 * reps)
        END
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX set_entries_exercise_entry_id_idx ON set_entries (exercise_entry_id);
CREATE INDEX set_entries_updated_at_idx ON set_entries (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE activities (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('cycling', 'climbing', 'running', 'hike', 'swim')),
    local_date date NOT NULL,
    started_at timestamptz,
    duration_min integer,
    distance_km numeric(8,2),
    elevation_m numeric(8,2),
    /* climb_grade is the label as logged (for example "V4"); climb_grade_value
       is the numeric grade used for V-points (sum of 2^grade) */
    climb_grade text,
    climb_grade_value numeric(4,1),
    routes_sent integer,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX activities_user_local_date_idx ON activities (user_id, local_date);
CREATE INDEX activities_updated_at_idx ON activities (updated_at) WHERE deleted_at IS NULL;

/* Body stats are owner-private: repository functions scope strictly by the
   session user and never include these rows in feeds or leaderboards. */
CREATE TABLE body_stats (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_date date NOT NULL,
    weight_kg numeric(5,2),
    bodyfat_pct numeric(4,1),
    neck_cm numeric(5,1),
    shoulders_cm numeric(5,1),
    chest_cm numeric(5,1),
    bicep_cm numeric(5,1),
    waist_cm numeric(5,1),
    hips_cm numeric(5,1),
    thigh_cm numeric(5,1),
    calf_cm numeric(5,1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX body_stats_user_local_date_idx ON body_stats (user_id, local_date);
CREATE INDEX body_stats_updated_at_idx ON body_stats (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE kudos (
    id uuid PRIMARY KEY,
    workout_id uuid NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (workout_id, user_id)
);

CREATE INDEX kudos_user_id_idx ON kudos (user_id);
CREATE INDEX kudos_updated_at_idx ON kudos (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE challenges (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    description text,
    start_date date NOT NULL,
    end_date date NOT NULL,
    /* NULL means the challenge spans the whole cohort */
    group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK (end_date >= start_date)
);

CREATE INDEX challenges_updated_at_idx ON challenges (updated_at) WHERE deleted_at IS NULL;

/* Idempotent sync dedupe: every outbox op replayed by POST /sync/push is
   recorded here by its client-generated op id; replays are no-ops. */
CREATE TABLE client_ops (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity text NOT NULL,
    action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    /* LWW timestamp of the mirrored row; pulls page on updated_at */
    updated_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_ops_user_id_updated_at_idx ON client_ops (user_id, updated_at);
