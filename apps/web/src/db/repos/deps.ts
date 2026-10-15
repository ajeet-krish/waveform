/**
 * Shared repository dependencies.
 *
 * Every synced row the repos write carries `user_id` from `userId` and
 * stamps `created_at`/`updated_at` from `now()` so one operation always
 * shares a single ISO timestamp (row and outbox op stay in lockstep for
 * last-write-wins).
 */

export type RepoDeps = {
  /** The signed-in user; stamped as user_id on every synced row. */
  userId: string;
  /** Clock override for tests; defaults to the real wall clock. */
  now?: () => Date;
};

/** Resolves the repo clock once per operation. */
export function nowDate(deps: RepoDeps): Date {
  return deps.now ? deps.now() : new Date();
}
