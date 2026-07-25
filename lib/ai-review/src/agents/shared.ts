/**
 * Shared building blocks for the three review agents.
 *
 * Each agent follows the same shape:
 *   1. a deterministic rule pass (guardrails that always run), and
 *   2. an optional LLM reasoning pass (qualitative judgment).
 * This module holds the pieces both passes need: context serialization,
 * severity→cap policy, and verdict assembly.
 */

import type {
  AgentRole,
  ConfidenceRank,
  GamePrediction,
  ReviewFlag,
  Severity,
} from "../types.js";
import type { LlmVerdict } from "../schema.js";
import { minRank } from "../confidence.js";

/** Numeric weight so we can pick the "worst" severity in a list. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function worstSeverity(flags: readonly ReviewFlag[]): Severity | null {
  let worst: Severity | null = null;
  for (const flag of flags) {
    if (worst === null || SEVERITY_WEIGHT[flag.severity] > SEVERITY_WEIGHT[worst]) {
      worst = flag.severity;
    }
  }
  return worst;
}

/**
 * Default cap policy shared by the deterministic passes:
 *  - a critical issue caps the pick at C (informational only), and
 *  - a warning caps it at B (can't be a headline S/A pick with an open warning).
 * Info-only findings impose no cap. Agents may override per-flag when a finding
 * warrants a different ceiling.
 */
export function capForSeverity(severity: Severity | null): ConfidenceRank | null {
  switch (severity) {
    case "critical":
      return "C";
    case "warning":
      return "B";
    default:
      return null;
  }
}

/** Combine two optional caps into the more conservative one. */
export function mergeCaps(
  a: ConfidenceRank | null,
  b: ConfidenceRank | null,
): ConfidenceRank | null {
  if (a === null) return b;
  if (b === null) return a;
  return minRank(a, b);
}

/** Tag a bare LLM concern with its owning agent to form a {@link ReviewFlag}. */
export function llmConcernsToFlags(
  agent: AgentRole,
  verdict: LlmVerdict,
): ReviewFlag[] {
  return verdict.concerns.map((c) => ({
    agent,
    severity: c.severity,
    code: c.code,
    message: c.message,
  }));
}

/** Normalize the LLM's `"none"` sentinel to a real cap (or null). */
export function llmRankToCap(
  suggested: LlmVerdict["suggestedMaxRank"],
): ConfidenceRank | null {
  return suggested === "none" ? null : suggested;
}

/**
 * Serialize a prediction into a compact, faithful text block for the model.
 * Keys are emitted in a fixed order so repeated reviews of structurally
 * identical games hash consistently. The full object is included — reviewers
 * decide what is relevant, we don't pre-filter.
 */
export function serializePrediction(pred: GamePrediction): string {
  const view = {
    gameId: pred.gameId,
    matchup: `${pred.away.abbreviation} @ ${pred.home.abbreviation}`,
    startTimeLocal: pred.startTimeLocal,
    preReviewConfidence: pred.confidence,
    data: pred.data,
    model: pred.model,
    keyFactors: pred.keyFactors ?? [],
  };
  return JSON.stringify(view, null, 2);
}

/** Round a fraction to a percentage string, e.g. 0.612 → "61.2%". */
export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
