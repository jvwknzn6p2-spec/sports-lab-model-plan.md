/**
 * Confidence-rank arithmetic for the review layer.
 *
 * The core invariant of Step 9 lives here: AI review can only ever *lower*
 * confidence, never raise it. Every function in this module is deterministic
 * and total, so the confidence math is fully auditable and testable without an
 * LLM.
 */

import type { AgentVerdict, ConfidenceRank } from "./types.js";

/** Ordered best → worst. Index doubles as the rank's numeric severity. */
export const RANK_ORDER: readonly ConfidenceRank[] = ["S", "A", "B", "C"];

/** Numeric position of a rank (0 = S, 3 = C). Higher = less confident. */
export function rankIndex(rank: ConfidenceRank): number {
  const idx = RANK_ORDER.indexOf(rank);
  // RANK_ORDER is exhaustive over ConfidenceRank, so this is unreachable, but
  // guarding keeps the function total for untyped callers.
  return idx === -1 ? RANK_ORDER.length - 1 : idx;
}

/**
 * Return the more conservative (lower-confidence) of two ranks.
 * `minRank("A", "C")` → "C".
 */
export function minRank(a: ConfidenceRank, b: ConfidenceRank): ConfidenceRank {
  return rankIndex(a) >= rankIndex(b) ? a : b;
}

/**
 * Drop a rank by `steps`, clamped at the worst rank (C). Negative steps are
 * treated as zero — this function never upgrades.
 */
export function downgrade(rank: ConfidenceRank, steps: number): ConfidenceRank {
  const target = rankIndex(rank) + Math.max(0, Math.trunc(steps));
  const clamped = Math.min(target, RANK_ORDER.length - 1);
  return RANK_ORDER[clamped]!;
}

/**
 * Apply a cap to a rank: the result is the more conservative of the current
 * rank and the cap. A cap can only hold the rank where it is or push it lower.
 */
export function capAt(rank: ConfidenceRank, cap: ConfidenceRank): ConfidenceRank {
  return minRank(rank, cap);
}

/**
 * Compute the final confidence rank from the original rank and every agent's
 * verdict. The result is the most conservative cap suggested by any agent, and
 * is guaranteed to be equal to or lower than `original`.
 */
export function applyReview(
  original: ConfidenceRank,
  verdicts: readonly AgentVerdict[],
): ConfidenceRank {
  let result = original;
  for (const verdict of verdicts) {
    if (verdict.suggestedMaxRank !== null) {
      result = capAt(result, verdict.suggestedMaxRank);
    }
  }
  // Belt and suspenders: the loop above can only lower the rank, but assert the
  // invariant explicitly so a future refactor can't silently break it.
  return capAt(original, result);
}
