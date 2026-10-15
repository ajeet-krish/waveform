/**
 * Error copy: one place that turns a thrown value into the sentences a
 * status region shows, keeping LocalValidationError's per-violation
 * issues intact instead of collapsing them into a generic apology.
 */

import { LocalValidationError } from "../db/validation";

/**
 * The issues to show for a failure: the violation list when the local
 * guard raised, the message when anything else did, an empty array when
 * the cause says nothing useful.
 */
export function errorIssues(cause: unknown): string[] {
  if (cause instanceof LocalValidationError) {
    return cause.issues;
  }
  if (cause instanceof Error && cause.message) {
    return [cause.message];
  }
  return [];
}

/** One line for a status region: the issues, or the caller's fallback. */
export function errorMessage(cause: unknown, fallback: string): string {
  const issues = errorIssues(cause);
  if (issues.length === 0) {
    return fallback;
  }
  return issues.join("; ");
}
