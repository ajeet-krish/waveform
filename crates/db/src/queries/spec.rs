//! Entity registry for the generic sync apply and pull.
//!
//! One [`EntitySpec`] per [`SyncEntity`] pins down every piece of SQL the
//! engine needs: which columns a payload may write, which column is
//! forced to the session user, which parents a payload must name, how to
//! probe row ownership, and how to pull the table scoped to a user.
//!
//! All SQL is built from these static strings ([`upsert_sql`] and
//! [`pull_sql`] interpolate only `&str` literals chosen by the enum
//! match); no user input ever reaches a query. Bind parameters carry the
//! ids, timestamps, and payload.

use crate::dto::SyncEntity;

/// A foreign-key parent a payload must (or may) name, plus how to prove
/// the parent exists and belongs to the pushing user.
#[derive(Debug, Clone, Copy)]
pub struct ParentCheck {
    /// Payload column holding the parent id (for example `workout_id`).
    pub column: &'static str,
    /// `false` for optional references such as
    /// `workout_sessions.routine_id`: absent or `null` skips the check.
    pub required: bool,
    /// SQL returning `(exists, owned_by_session_user)`; `$1` is the
    /// parent id, `$2` the session user id. A missing parent is
    /// retryable (the parent may arrive in a later batch); a parent that
    /// exists under another user is rejected.
    pub probe: &'static str,
}

/// Static description of one syncable table.
#[derive(Debug, Clone, Copy)]
pub struct EntitySpec {
    /// Physical table name.
    pub table: &'static str,
    /// Ownership column forced to the session user on every write
    /// (`user_id`, or `owner_id` for exercises). `None` for child tables
    /// that carry no owner column of their own: their ownership is the
    /// parent path, proven by [`EntitySpec::parents`] and
    /// [`EntitySpec::owner_probe`] before any write.
    pub owner_column: Option<&'static str>,
    /// Columns a payload may write, excluding `id`, the owner column,
    /// and the server-owned `applied_at`, `e1rm_kg`, `updated_at`, and
    /// `deleted_at` (those are bound explicitly).
    pub columns: &'static [&'static str],
    /// Timestamp columns the apply phase normalizes before the upsert:
    /// `updated_at` and `deleted_at` are stripped from the payload and
    /// bound from the clamp and the action, a missing `created_at` is
    /// filled from the clamped `updated_at` (it is NOT NULL everywhere),
    /// and the rest (for example `started_at`) fall through to the
    /// payload or SQL NULL.
    pub timestamp_columns: &'static [&'static str],
    /// Parents the payload references, in column order.
    pub parents: &'static [ParentCheck],
    /// SQL returning the owner of an existing row as `Option<Uuid>`
    /// (`None` when no row exists; exercises can also return SQL NULL
    /// for a server-owned catalog row). `$1` is the row id.
    pub owner_probe: &'static str,
    /// FROM clause for pull, base table aliased `t`, joins that reach
    /// the owner already applied.
    pub pull_from: &'static str,
    /// Owner predicate for pull; `$1` is the session user id.
    pub pull_owner: &'static str,
}

const WORKOUT_PROBE: &str = "SELECT EXISTS (SELECT 1 FROM workout_sessions WHERE id = $1), \
            EXISTS (SELECT 1 FROM workout_sessions WHERE id = $1 AND user_id = $2)";

const ROUTINE_PROBE: &str = "SELECT EXISTS (SELECT 1 FROM routines WHERE id = $1), \
            EXISTS (SELECT 1 FROM routines WHERE id = $1 AND user_id = $2)";

/// Global rows are visible to everyone; custom rows only to their owner.
const EXERCISE_PROBE: &str = "SELECT EXISTS (SELECT 1 FROM exercises WHERE id = $1), \
            EXISTS (SELECT 1 FROM exercises WHERE id = $1 AND (owner_id IS NULL OR owner_id = $2))";

const ENTRY_PROBE: &str = "SELECT EXISTS (SELECT 1 FROM exercise_entries WHERE id = $1), \
            EXISTS (SELECT 1 FROM exercise_entries ee \
                    JOIN workout_sessions w ON w.id = ee.workout_id \
                    WHERE ee.id = $1 AND w.user_id = $2)";

const EXERCISES: EntitySpec = EntitySpec {
    table: "exercises",
    owner_column: Some("owner_id"),
    columns: &["name", "muscle_group", "equipment", "created_at"],
    timestamp_columns: &["created_at", "updated_at", "deleted_at"],
    parents: &[],
    owner_probe: "SELECT owner_id FROM exercises WHERE id = $1",
    pull_from: "exercises AS t",
    pull_owner: "t.owner_id = $1",
};

const WORKOUT_SESSIONS: EntitySpec = EntitySpec {
    table: "workout_sessions",
    owner_column: Some("user_id"),
    columns: &[
        "local_date",
        "started_at",
        "duration_min",
        "routine_id",
        "notes",
        "created_at",
    ],
    timestamp_columns: &["started_at", "created_at", "updated_at", "deleted_at"],
    parents: &[ParentCheck {
        column: "routine_id",
        required: false,
        probe: ROUTINE_PROBE,
    }],
    owner_probe: "SELECT user_id FROM workout_sessions WHERE id = $1",
    pull_from: "workout_sessions AS t",
    pull_owner: "t.user_id = $1",
};

const EXERCISE_ENTRIES: EntitySpec = EntitySpec {
    table: "exercise_entries",
    owner_column: None,
    columns: &[
        "workout_id",
        "exercise_id",
        "order_index",
        "notes",
        "created_at",
    ],
    timestamp_columns: &["created_at", "updated_at", "deleted_at"],
    // workout_id is the row's own owner path; it is checked through the
    // parent list below so a missing parent is retryable before any write.
    parents: &[
        ParentCheck {
            column: "workout_id",
            required: true,
            probe: WORKOUT_PROBE,
        },
        ParentCheck {
            column: "exercise_id",
            required: true,
            probe: EXERCISE_PROBE,
        },
    ],
    owner_probe: "SELECT w.user_id FROM exercise_entries ee \
                  JOIN workout_sessions w ON w.id = ee.workout_id WHERE ee.id = $1",
    pull_from: "exercise_entries AS t JOIN workout_sessions AS w ON w.id = t.workout_id",
    pull_owner: "w.user_id = $1",
};

const SET_ENTRIES: EntitySpec = EntitySpec {
    table: "set_entries",
    owner_column: None,
    columns: &[
        "exercise_entry_id",
        "set_index",
        "weight_kg",
        "reps",
        "is_warmup",
        "created_at",
    ],
    timestamp_columns: &["created_at", "updated_at", "deleted_at"],
    parents: &[ParentCheck {
        column: "exercise_entry_id",
        required: true,
        probe: ENTRY_PROBE,
    }],
    owner_probe: "SELECT w.user_id FROM set_entries s \
                  JOIN exercise_entries ee ON ee.id = s.exercise_entry_id \
                  JOIN workout_sessions w ON w.id = ee.workout_id WHERE s.id = $1",
    pull_from: "set_entries AS t \
                JOIN exercise_entries AS ee ON ee.id = t.exercise_entry_id \
                JOIN workout_sessions AS w ON w.id = ee.workout_id",
    pull_owner: "w.user_id = $1",
};

const ACTIVITIES: EntitySpec = EntitySpec {
    table: "activities",
    owner_column: Some("user_id"),
    columns: &[
        "type",
        "local_date",
        "started_at",
        "duration_min",
        "distance_km",
        "elevation_m",
        "climb_grade",
        "climb_grade_value",
        "routes_sent",
        "notes",
        "created_at",
    ],
    timestamp_columns: &["started_at", "created_at", "updated_at", "deleted_at"],
    parents: &[],
    owner_probe: "SELECT user_id FROM activities WHERE id = $1",
    pull_from: "activities AS t",
    pull_owner: "t.user_id = $1",
};

const BODY_STATS: EntitySpec = EntitySpec {
    table: "body_stats",
    owner_column: Some("user_id"),
    columns: &[
        "local_date",
        "weight_kg",
        "bodyfat_pct",
        "neck_cm",
        "shoulders_cm",
        "chest_cm",
        "bicep_cm",
        "waist_cm",
        "hips_cm",
        "thigh_cm",
        "calf_cm",
        "created_at",
    ],
    timestamp_columns: &["created_at", "updated_at", "deleted_at"],
    parents: &[],
    owner_probe: "SELECT user_id FROM body_stats WHERE id = $1",
    pull_from: "body_stats AS t",
    pull_owner: "t.user_id = $1",
};

const ROUTINES: EntitySpec = EntitySpec {
    table: "routines",
    owner_column: Some("user_id"),
    columns: &["name", "notes", "created_at"],
    timestamp_columns: &["created_at", "updated_at", "deleted_at"],
    parents: &[],
    owner_probe: "SELECT user_id FROM routines WHERE id = $1",
    pull_from: "routines AS t",
    pull_owner: "t.user_id = $1",
};

const ROUTINE_ENTRIES: EntitySpec = EntitySpec {
    table: "routine_entries",
    owner_column: None,
    columns: &[
        "routine_id",
        "exercise_id",
        "order_index",
        "target_sets",
        "target_reps",
        "target_weight_kg",
        "created_at",
    ],
    timestamp_columns: &["created_at", "updated_at", "deleted_at"],
    parents: &[
        ParentCheck {
            column: "routine_id",
            required: true,
            probe: ROUTINE_PROBE,
        },
        ParentCheck {
            column: "exercise_id",
            required: true,
            probe: EXERCISE_PROBE,
        },
    ],
    owner_probe: "SELECT r.user_id FROM routine_entries re \
                  JOIN routines r ON r.id = re.routine_id WHERE re.id = $1",
    pull_from: "routine_entries AS t JOIN routines AS r ON r.id = t.routine_id",
    pull_owner: "r.user_id = $1",
};

/// The registry lookup. Only enum matches, so every SQL string is static.
pub fn spec_for(entity: SyncEntity) -> &'static EntitySpec {
    match entity {
        SyncEntity::Exercises => &EXERCISES,
        SyncEntity::WorkoutSessions => &WORKOUT_SESSIONS,
        SyncEntity::ExerciseEntries => &EXERCISE_ENTRIES,
        SyncEntity::SetEntries => &SET_ENTRIES,
        SyncEntity::Activities => &ACTIVITIES,
        SyncEntity::BodyStats => &BODY_STATS,
        SyncEntity::Routines => &ROUTINES,
        SyncEntity::RoutineEntries => &ROUTINE_ENTRIES,
    }
}

/// Build the generic upsert.
///
/// The payload flows through `jsonb_populate_record` so column list and
/// value list stay in lock step; `id` (`$2`), the forced owner (`$3`,
/// tables that have one), `updated_at` (already clamped), and
/// `deleted_at` are bound explicitly so a payload can never override
/// them. The `ON CONFLICT ... WHERE table.updated_at <
/// EXCLUDED.updated_at` guard closes the LWW race between the ownership
/// read and the write: if a newer row landed concurrently the upsert
/// quietly becomes a no-op.
///
/// `tombstone` selects the delete shape: the INSERT still carries the
/// payload (a delete for a row this server has never seen inserts a
/// tombstoned row), but the UPDATE only advances `updated_at` and sets
/// `deleted_at`, keeping the stored payload like the contract requires.
/// Otherwise create and update write every payload column, force the
/// owner, and clear `deleted_at` so a newer update resurrects.
pub fn upsert_sql(spec: &EntitySpec, tombstone: bool) -> String {
    let table = spec.table;
    // Bind layout: $1 payload, $2 row id, $3 forced owner (tables that
    // have one), then the timestamps. Child tables without an owner
    // column number their timestamps from $3; the numbering is still
    // static per spec, chosen by the enum match, never by input.
    let (updated_at_param, deleted_at_param) = match spec.owner_column {
        Some(_) => ("$4::timestamptz", "$5::timestamptz"),
        None => ("$3::timestamptz", "$4::timestamptz"),
    };
    let mut insert_columns: Vec<String> = vec!["id".to_owned()];
    let mut select_list: Vec<String> = vec!["$2::uuid".to_owned()];
    if let Some(owner) = spec.owner_column {
        insert_columns.push(owner.to_owned());
        select_list.push("$3::uuid".to_owned());
    }
    insert_columns.push(spec.columns.join(", "));
    insert_columns.push("updated_at, deleted_at".to_owned());
    select_list.push(
        spec.columns
            .iter()
            .map(|column| format!("p.{column}"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    select_list.push(updated_at_param.to_owned());
    select_list.push(deleted_at_param.to_owned());

    let mut assignments: Vec<String> = if tombstone {
        Vec::new()
    } else {
        spec.columns
            .iter()
            .map(|column| format!("{column} = EXCLUDED.{column}"))
            .collect()
    };
    if !tombstone {
        if let Some(owner) = spec.owner_column {
            assignments.push(format!("{owner} = EXCLUDED.{owner}"));
        }
    }
    assignments.push("updated_at = EXCLUDED.updated_at".to_owned());
    assignments.push("deleted_at = EXCLUDED.deleted_at".to_owned());
    let set_clause = assignments.join(", ");

    format!(
        "INSERT INTO {table} ({}) \
         SELECT {} FROM jsonb_populate_record(NULL::{table}, $1) AS p \
         ON CONFLICT (id) DO UPDATE SET {set_clause} \
         WHERE {table}.updated_at < EXCLUDED.updated_at",
        insert_columns.join(", "),
        select_list.join(", "),
    )
}

/// Build the pull page query: JSON payload minus `applied_at` (exposed
/// as a column instead), owner-scoped, `(applied_at, id)` exclusive
/// cursor, ordered the same way. `$1` user, `$2` cursor timestamp, `$3`
/// cursor id, `$4` limit.
pub fn pull_sql(spec: &EntitySpec) -> String {
    let from = spec.pull_from;
    let owner = spec.pull_owner;
    format!(
        "SELECT to_jsonb(t) - 'applied_at' AS payload, t.applied_at, t.id \
         FROM {from} \
         WHERE {owner} AND (t.applied_at, t.id) > ($2::timestamptz, $3::uuid) \
         ORDER BY t.applied_at, t.id \
         LIMIT $4"
    )
}

#[cfg(test)]
mod tests {
    use super::{pull_sql, spec_for, upsert_sql};
    use crate::dto::SyncEntity;

    #[test]
    fn every_entity_has_a_spec() {
        for entity in SyncEntity::ALL {
            let spec = spec_for(entity);
            assert!(!spec.table.is_empty());
            assert!(!spec.columns.is_empty());
            // applied_at, e1rm_kg, updated_at, and deleted_at are server
            // owned and must never be payload writable.
            for forbidden in ["applied_at", "e1rm_kg", "updated_at", "deleted_at", "id"] {
                assert!(
                    !spec.columns.contains(&forbidden),
                    "{} must not write {forbidden}",
                    spec.table
                );
            }
            // Every table normalizes the three core stamps.
            for stamp in ["created_at", "updated_at", "deleted_at"] {
                assert!(
                    spec.timestamp_columns.contains(&stamp),
                    "{} must normalize {stamp}",
                    spec.table
                );
            }
        }
    }

    #[test]
    fn upsert_never_interpolates_payload_values() {
        let spec = spec_for(SyncEntity::SetEntries);
        let sql = upsert_sql(spec, false);
        assert!(sql.contains("jsonb_populate_record(NULL::set_entries, $1)"));
        assert!(sql.contains("ON CONFLICT (id) DO UPDATE"));
        assert!(sql.contains("WHERE set_entries.updated_at < EXCLUDED.updated_at"));
        // The generated column and the cursor stamp stay server owned.
        assert!(!sql.contains("e1rm_kg"));
        assert!(!sql.contains("applied_at"));
        // Child tables have no owner column: timestamps number from $3.
        assert!(sql.contains("$3::timestamptz"));
        assert!(sql.contains("$4::timestamptz"));
        assert!(!sql.contains("$3::uuid"));

        // Owner-carrying tables force the session user at $3.
        let owned = upsert_sql(spec_for(SyncEntity::BodyStats), false);
        assert!(owned.contains("user_id, local_date"));
        assert!(owned.contains("$3::uuid"));
        assert!(owned.contains("$5::timestamptz"));
        assert!(owned.contains("user_id = EXCLUDED.user_id"));
    }

    #[test]
    fn tombstone_upsert_keeps_the_stored_payload() {
        let spec = spec_for(SyncEntity::WorkoutSessions);
        let write = upsert_sql(spec, false);
        assert!(write.contains("local_date = EXCLUDED.local_date"));
        assert!(write.contains("deleted_at = EXCLUDED.deleted_at"));

        let tombstone = upsert_sql(spec, true);
        assert!(tombstone.contains(
            "DO UPDATE SET updated_at = EXCLUDED.updated_at, deleted_at = EXCLUDED.deleted_at"
        ));
        assert!(!tombstone.contains("notes = EXCLUDED.notes"));
    }

    #[test]
    fn pull_pages_on_the_composite_cursor() {
        let sql = pull_sql(spec_for(SyncEntity::Activities));
        assert!(sql.contains("(t.applied_at, t.id) > ($2::timestamptz, $3::uuid)"));
        assert!(sql.contains("ORDER BY t.applied_at, t.id"));
        assert!(sql.contains("LIMIT $4"));
        assert!(sql.contains("to_jsonb(t) - 'applied_at'"));
        assert!(sql.contains("t.user_id = $1"));
    }
}
