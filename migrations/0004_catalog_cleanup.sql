/* Catalog cleanup: retire seven duplicate global exercise names.

   0002_seed_catalog.sql seeded canonical spellings and their plural or
   reworded twins of the same movement (for example "Chest Dip" next to
   "Chest Dips"), so the global catalog offered two rows for one
   exercise. Append-only discipline: 0002 is never edited; this migration
   soft-deletes the seven duplicates instead.

   Soft delete only, never a hard delete: history resolves exercise names
   from raw rows including tombstones, so old entries keep their display
   name, and the sync pull still learns the removal as a tombstone.
   updated_at moves with deleted_at because pull pages order on it; a
   tombstone stamped with an old updated_at would be invisible to devices
   that already pulled past that timestamp. The AND deleted_at IS NULL
   guard keeps a re-run from re-stamping rows it already retired.

   The client mirrors this cleanup in
   apps/web/src/db/seed/ensureCatalog.ts from CATALOG_REMOVED_NAMES, and
   apps/web/src/db/seed/catalogParity.test.ts parses this file and fails
   if the two removal lists drift. */

UPDATE exercises
SET deleted_at = now(), updated_at = now()
WHERE owner_id IS NULL
  AND lower(name) IN (
      'ab wheel',
      'chest dips',
      'chin-ups',
      'dumbbell curl',
      'dumbbell row',
      'incline barbell bench press',
      'lateral raise'
  )
  AND deleted_at IS NULL;
