/* Catalog dedup: hard delete the 27 duplicate global rows and restore
   "Ab Wheel".

   0002_seed_catalog.sql seeded two naming sets: the original canonical
   names (for example "Bench Press (Barbell)") followed by a wider
   catalog that repeated many of them as plain-named twins (for example
   "Flat Barbell Bench Press"). The first set is kept; the 27 duplicate
   names below are retired. Append-only discipline: 0002 and
   0004_catalog_cleanup.sql are never edited; this migration layers the
   final decision on top.

   Hard delete, not a soft delete: the catalog should carry no
   tombstone remnants, so the duplicate rows leave the table entirely.
   This is safe only while no exercise_entries row references these
   catalog rows: exercise_entries.exercise_id is ON DELETE RESTRICT
   (0003_hardening.sql), so a referenced row would abort the delete.
   Today nothing references them (the backend is deferred and logging
   only ever pointed at the first-set names); should that change, the
   RESTRICT constraint fails loudly instead of cascading.

   "Ab Wheel" is restored because it belongs to the kept first set:
   0004 soft-deleted it as part of its seven-name cleanup, but the
   dedup keeps the first-set spelling, so the tombstone is lifted.
   The client mirrors this migration in
   apps/web/src/db/seed/ensureCatalog.ts (reconcile to seed), and
   apps/web/src/db/seed/catalogParity.test.ts parses this file and
   fails if the two removal lists drift. */

DELETE FROM exercises
WHERE owner_id IS NULL
  AND lower(name) IN (
      'ab wheel rollout',
      'back squat',
      'barbell row',
      'chest dips',
      'chin-ups',
      'deadlift',
      'dips (tricep)',
      'dumbbell curl',
      'dumbbell fly',
      'dumbbell row',
      'flat barbell bench press',
      'flat dumbbell press',
      'hyperextension',
      'incline barbell bench press',
      'incline dumbbell press',
      'lateral raise',
      'overhead press',
      'overhead tricep extension',
      'pull-ups',
      'push-ups',
      'seated dumbbell press',
      'single arm dumbbell row',
      'skull crushers',
      'standing dumbbell press',
      'stiff leg deadlift',
      'tricep pushdown',
      'walking lunges'
  );

UPDATE exercises
SET deleted_at = NULL
WHERE owner_id IS NULL
  AND lower(name) = 'ab wheel'
  AND deleted_at IS NOT NULL;
