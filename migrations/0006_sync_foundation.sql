/* Phase 2 bucket 1: sync foundation (password column, exercise pull
   participation, UUIDv5 catalog id convergence).

   Append-only discipline: 0001 through 0005 are never edited; this file
   layers the phase 2 decisions on top. Like every migration it is applied
   exactly once per database by the sqlx runner, and every statement here
   is additionally written so that re-running the whole file on an already
   migrated database is a no-op (IF NOT EXISTS guards, CREATE OR REPLACE,
   and id-remap UPDATEs that match zero rows once the ids are converged).
   That re-entrancy is proven by crates/db/tests/catalog_uuidv5.rs, which
   executes this file twice.

   Dev reversibility: the local Docker volume holds development-only data,
   so a migration experiment that goes wrong is undone with
   `docker compose -f infra/docker-compose.yml down -v` and rebuilt from
   scratch with `cargo run -p waveform-api -- migrate`. There is no down
   migration by design; append-only forward fixes are cheaper than
   reversible ones at this stage.

   Parity fence: waveform_uuidv5 / waveform_catalog_id must produce byte
   for byte the same ids as apps/web/src/db/seed/uuidV5.ts (RFC 4122
   UUIDv5 over the DNS namespace and lower(name)). The fence has three
   legs: this SQL, the golden vectors in crates/db/tests/catalog_uuidv5.rs
   (SQL versus uuid::new_v5), and the same golden vectors in the client
   vitest suite. Change one and the others fail.

   Contents:
   1. users.password_hash: groundwork for email + password accounts. The
      column is nullable; Argon2id PHC strings land in bucket 2 and login
      rejects NULL. No OTP, no MFA, no email verification (see ADR
      2026-10-15 in docs/decisions.md).
   2. exercises gains applied_at plus the stamp_applied_at trigger from
      0003 (the function is reused, not redefined) and an
      (owner_id, applied_at, id) index, so custom exercises participate in
      the pull cursor like every other synced row.
   3. Plain (applied_at, id) pull indexes on the three child tables whose
      owner is reached through a join, so the pull ORDER BY is an index
      range scan after the join filter.
   4. Core-Postgres UUIDv5 (no pgcrypto): waveform_sha1 is a plpgsql
      SHA-1, waveform_uuidv5 sets the version and variant bits with
      set_byte, and waveform_catalog_id folds the name through lower() to
      mirror the SQL unique key.
   5. Global catalog ids converge to the client-derived UUIDv5 form, and
      exercise_entries / routine_entries follow their parents in the same
      transaction. The two FKs become DEFERRABLE INITIALLY IMMEDIATE and
      the transaction runs SET CONSTRAINTS ALL DEFERRED so parent and
      child id updates coexist; guards raise a clear exception on a name
      collision or an occupied target id instead of failing mid-remap. */

/* 1. Password column for email + password auth (handlers land in bucket 2;
   login must reject a NULL hash). */
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

/* 2. Custom exercises participate in pull. The trigger function
   stamp_applied_at() already exists from 0003; reuse it. Adding the
   trigger before the id remap means the remap itself restamps
   applied_at, so devices re-pull the re-keyed rows. */
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS applied_at timestamptz NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS exercises_applied_at ON exercises;
CREATE TRIGGER exercises_applied_at BEFORE INSERT OR UPDATE ON exercises
    FOR EACH ROW EXECUTE FUNCTION stamp_applied_at();
CREATE INDEX IF NOT EXISTS exercises_sync_idx ON exercises (owner_id, applied_at, id);

/* 3. Plain pull indexes for child tables: owner filtering happens through
   the parent join, ordering pages on (applied_at, id) with tombstones
   included. */
CREATE INDEX IF NOT EXISTS exercise_entries_pull_idx ON exercise_entries (applied_at, id);
CREATE INDEX IF NOT EXISTS set_entries_pull_idx ON set_entries (applied_at, id);
CREATE INDEX IF NOT EXISTS routine_entries_pull_idx ON routine_entries (applied_at, id);

/* 4. UUIDv5 helpers in core Postgres only (no pgcrypto). The SHA-1
   implementation follows FIPS 180-4 over bytea; the uuidv5 wrapper sets
   version 5 and the RFC 4122 variant with set_byte, exactly like
   uuidV5.ts does with Web Crypto, and waveform_catalog_id lowercases the
   name to mirror the SQL unique key on lower(name). */

CREATE OR REPLACE FUNCTION waveform_rol32(x bigint, n integer) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT (((x & 4294967295) << n) | ((x & 4294967295) >> (32 - n))) & 4294967295
$$;

CREATE OR REPLACE FUNCTION waveform_sha1(data bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    mask CONSTANT bigint := 4294967295;
    msg_len CONSTANT bigint := length(data);
    padded bytea;
    chunk bytea;
    w bigint[] := array_fill(0::bigint, ARRAY[80]);
    h0 bigint := 1732584193;   /* 0x67452301 */
    h1 bigint := 4023233417;   /* 0xEFCDAB89 */
    h2 bigint := 2562383102;   /* 0x98BADCFE */
    h3 bigint := 271733878;    /* 0x10325476 */
    h4 bigint := 3285377520;   /* 0xC3D2E1F0 */
    a bigint; b bigint; c bigint; d bigint; e bigint;
    f bigint; k bigint; tmp bigint;
    chunks integer; i integer; t integer;
BEGIN
    /* Padding: 0x80, zero bytes up to 56 mod 64, then the 64-bit
       big-endian bit length. */
    padded := data || '\x80'::bytea;
    WHILE length(padded) % 64 <> 56 LOOP
        padded := padded || '\x00'::bytea;
    END LOOP;
    padded := padded || decode(lpad(to_hex(msg_len * 8), 16, '0'), 'hex');

    chunks := length(padded) / 64;
    FOR i IN 0 .. chunks - 1 LOOP
        chunk := substr(padded, i * 64 + 1, 64);
        FOR t IN 0 .. 15 LOOP
            w[t + 1] := (get_byte(chunk, t * 4)::bigint << 24)
                      | (get_byte(chunk, t * 4 + 1)::bigint << 16)
                      | (get_byte(chunk, t * 4 + 2)::bigint << 8)
                      | get_byte(chunk, t * 4 + 3)::bigint;
        END LOOP;
        FOR t IN 16 .. 79 LOOP
            w[t + 1] := waveform_rol32(w[t - 2] # w[t - 7] # w[t - 13] # w[t - 15], 1);
        END LOOP;

        a := h0; b := h1; c := h2; d := h3; e := h4;
        FOR t IN 0 .. 79 LOOP
            IF t < 20 THEN
                f := (b & c) | ((~b) & d);
                k := 1518500249;   /* 0x5A827999 */
            ELSIF t < 40 THEN
                f := b # c # d;
                k := 1859775393;   /* 0x6ED9EBA1 */
            ELSIF t < 60 THEN
                f := (b & c) | (b & d) | (c & d);
                k := 2400959708;   /* 0x8F1BBCDC */
            ELSE
                f := b # c # d;
                k := 3395469782;   /* 0xCA62C1D6 */
            END IF;
            tmp := waveform_rol32(a, 5) + f + e + k + w[t + 1];
            e := d;
            d := c;
            c := waveform_rol32(b, 30);
            b := a;
            a := tmp & mask;
        END LOOP;

        h0 := (h0 + a) & mask;
        h1 := (h1 + b) & mask;
        h2 := (h2 + c) & mask;
        h3 := (h3 + d) & mask;
        h4 := (h4 + e) & mask;
    END LOOP;

    RETURN decode(
        lpad(to_hex(h0), 8, '0') || lpad(to_hex(h1), 8, '0') ||
        lpad(to_hex(h2), 8, '0') || lpad(to_hex(h3), 8, '0') ||
        lpad(to_hex(h4), 8, '0'),
        'hex');
END;
$$;

/* RFC 4122 UUIDv5: sha1(namespace_bytes || utf8(name)), first 16 bytes,
   version nibble 5, variant 10. Mirrors catalogSeedId in uuidV5.ts. */
CREATE OR REPLACE FUNCTION waveform_uuidv5(namespace uuid, name text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    digest bytea;
    uuid_bytes bytea;
BEGIN
    digest := waveform_sha1(
        decode(replace(namespace::text, '-', ''), 'hex') || convert_to(name, 'UTF8')
    );
    uuid_bytes := substr(digest, 1, 16);
    uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 80);
    uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
    RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$;

/* Deterministic catalog id: UUIDv5 over the RFC 4122 DNS namespace of
   lower(name), the same label uuidV5.ts hashes. */
CREATE OR REPLACE FUNCTION waveform_catalog_id(name text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT waveform_uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, lower(name))
$$;

/* 5. Catalog id convergence. The two FKs that point at exercises become
   DEFERRABLE INITIALLY IMMEDIATE so parent and child id updates can
   coexist in one transaction under SET CONSTRAINTS ALL DEFERRED; outside
   the migration they keep checking immediately, exactly as before. */
ALTER TABLE exercise_entries
    ALTER CONSTRAINT exercise_entries_exercise_id_fkey
    DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE routine_entries
    ALTER CONSTRAINT routine_entries_exercise_id_fkey
    DEFERRABLE INITIALLY IMMEDIATE;

SET CONSTRAINTS ALL DEFERRED;

/* Guards: fail loudly with a clear message instead of half-remapping.
   Re-running with converged ids matches nothing and passes. */
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM exercises
        WHERE owner_id IS NULL
        GROUP BY waveform_catalog_id(name)
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION
            'migration 0006: two global catalog names collide onto one uuidv5 id';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM exercises AS target
        WHERE target.owner_id IS NULL
          AND EXISTS (
              SELECT 1
              FROM exercises AS other
              WHERE other.id = waveform_catalog_id(target.name)
                AND other.id <> target.id
          )
    ) THEN
        RAISE EXCEPTION
            'migration 0006: uuidv5 target id for a global catalog row is already occupied';
    END IF;
END $$;

/* Children first while parents still hold the old ids, so the join finds
   them; with constraints deferred the commit validates the final state. */
UPDATE exercise_entries AS child
SET exercise_id = waveform_catalog_id(parent.name)
FROM exercises AS parent
WHERE parent.owner_id IS NULL
  AND child.exercise_id = parent.id
  AND parent.id <> waveform_catalog_id(parent.name);

UPDATE routine_entries AS child
SET exercise_id = waveform_catalog_id(parent.name)
FROM exercises AS parent
WHERE parent.owner_id IS NULL
  AND child.exercise_id = parent.id
  AND parent.id <> waveform_catalog_id(parent.name);

UPDATE exercises
SET id = waveform_catalog_id(name)
WHERE owner_id IS NULL
  AND id <> waveform_catalog_id(name);
