/**
 * Orchestrator for Step 9 — runs the three specialist agents over a prediction,
 * aggregates their verdicts, and computes the reviewed confidence rank.
 *
 * Ordering note: the plan says to "start with the Data Auditor, then add
 * Matchup Analyst and Risk Reviewer." Conceptually the auditor comes first, but
 * the three agents are independent reviewers of the same immutable prediction,
 * so we run them concurrently for latency and combine results deterministically.
 * The AI-only-downgrades invariant is enforced in {@link applyReview}.
 */

import type {
  AgentVerdict,
  GamePrediction,
  ReviewFlag,
  ReviewResult,
  Severity,
} from "./types.js";
import type { ReviewProvider } from "./provider.js";
import { HeuristicReviewProvider } from "./provider.js";
import { applyReview, rankIndex } from "./confidence.js";
import { reviewDataAuditor } from "./agents/data-auditor.js";
import { reviewMatchupAnalyst } from "./agents/matchup-analyst.js";
import { reviewRiskReviewer } from "./agents/risk-reviewer.js";

export interface ReviewOptions {
  /**
   * Reasoning provider. Defaults to the offline heuristic provider so a review
   * always runs, even with no API key.
   */
  provider?: ReviewProvider;
  /** Injected clock for staleness checks and timestamps. Defaults to now. */
  now?: Date;
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Sort flags most-severe first, stable within a severity. */
function sortFlags(flags: readonly ReviewFlag[]): ReviewFlag[] {
  return [...flags].sort(
    (a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity],
  );
}

/** Build the human-readable warning lines for the report. */
function buildWarnings(
  flags: readonly ReviewFlag[],
  original: string,
  final: string,
): string[] {
  const lines = flags
    .filter((f) => f.severity !== "info")
    .map((f) => `[${f.severity.toUpperCase()}] (${f.agent}) ${f.message}`);
  if (final !== original) {
    lines.unshift(`Confidence downgraded ${original} → ${final} after AI review.`);
  }
  return lines;
}

/** Review a single prediction with all three agents. */
export async function reviewPrediction(
  pred: GamePrediction,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const provider = options.provider ?? new HeuristicReviewProvider();
  const now = options.now ?? new Date();

  const verdicts: AgentVerdict[] = await Promise.all([
    reviewDataAuditor(pred, provider, now),
    reviewMatchupAnalyst(pred, provider),
    reviewRiskReviewer(pred, provider),
  ]);

  const finalConfidence = applyReview(pred.confidence, verdicts);
  const flags = sortFlags(verdicts.flatMap((v) => v.flags));
  const downgraded = rankIndex(finalConfidence) > rankIndex(pred.confidence);

  return {
    gameId: pred.gameId,
    originalConfidence: pred.confidence,
    finalConfidence,
    downgraded,
    verdicts,
    flags,
    warnings: buildWarnings(flags, pred.confidence, finalConfidence),
    reviewedAt: now.toISOString(),
  };
}

/**
 * Review a full slate. Predictions are independent, so they run concurrently
 * up to `concurrency` at a time — enough to keep API throughput up without
 * hammering rate limits on a large slate.
 */
export async function reviewSlate(
  predictions: readonly GamePrediction[],
  options: ReviewOptions & { concurrency?: number } = {},
): Promise<ReviewResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: ReviewResult[] = new Array(predictions.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < predictions.length) {
      const index = cursor++;
      results[index] = await reviewPrediction(predictions[index]!, options);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, predictions.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
