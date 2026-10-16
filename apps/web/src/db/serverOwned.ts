/**
 * Server-owned (catalog) row classification, shared by the backup
 * import and the outbox drain.
 *
 * The global exercise catalog is server-owned: its rows carry
 * `owner_id` null and are seeded from the server, so the client must
 * never queue an outbox op for one. Both the import and the drain use
 * this one predicate so the rule lives in exactly one place.
 */

import type { OutboxEntity } from "./types";

/**
 * True only for a server-owned catalog row: an `exercises` row with
 * `owner_id` null. Every other entity (and every custom exercise, which
 * carries an owner) is user-owned and pushes normally.
 */
export function isServerOwnedRow(entity: OutboxEntity, row: unknown): boolean {
  if (entity !== "exercises") {
    return false;
  }
  if (row === null || typeof row !== "object") {
    return false;
  }
  return (row as { owner_id?: string | null }).owner_id === null;
}
