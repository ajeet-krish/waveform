/**
 * Stale-row guard for positional lists.
 *
 * Solid's `<Index>` keeps one component instance per position while the
 * item at that position can change under it (reorder, insert, remove). A
 * row that owns local form state then keeps showing the previous item's
 * text, and a blur commit compares that stale text against the new item,
 * silently overwriting the wrong row's values. This has bitten SetLog's
 * SetRow and RoutineSlotRow.
 *
 * Feed the identity of the item a row currently shows to `isNew`; it
 * returns true exactly once per distinct identity, which is the signal to
 * resync the row's local state from the current item. The identity can be
 * a plain id, or a composite such as `${id}:${unit}` when another input
 * (for example the display unit) also changes what the row should show.
 *
 * The tracker remembers one identity and does nothing else, so the
 * stale-row rule is unit-testable without a DOM or IndexedDB.
 */
export type IdChangeTracker = {
  /** True the first time an identity is seen and every time it changes. */
  isNew(identity: string): boolean;
};

/**
 * Builds an {@link IdChangeTracker}. Pass the identity a row is currently
 * synced to so its first `isNew` call reports no change, matching the
 * signals the row initialized from that item.
 */
export function createIdChangeTracker(initialIdentity?: string): IdChangeTracker {
  let last = initialIdentity;
  return {
    isNew(identity: string): boolean {
      if (identity === last) {
        return false;
      }
      last = identity;
      return true;
    },
  };
}
