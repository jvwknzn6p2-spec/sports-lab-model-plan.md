/**
 * @workspace/ai-review — Step 9 of the AI Sports Lab pipeline.
 *
 * The AI multi-agent review layer: a final sanity check that runs three
 * specialist reviewers (Data Auditor, Matchup Analyst, Risk Reviewer) over a
 * finished prediction and returns an adjusted confidence rank plus warnings.
 *
 * Quick start:
 *
 * ```ts
 * import { reviewPrediction, defaultProvider } from "@workspace/ai-review";
 *
 * const result = await reviewPrediction(prediction, {
 *   provider: defaultProvider(), // Anthropic if ANTHROPIC_API_KEY is set, else offline
 * });
 * console.log(result.finalConfidence, result.warnings);
 * ```
 */

// Public API — functions
export { reviewPrediction, reviewSlate } from "./orchestrator.js";
export {
  defaultProvider,
  AnthropicReviewProvider,
  HeuristicReviewProvider,
} from "./provider.js";
export {
  applyReview,
  capAt,
  downgrade,
  minRank,
  rankIndex,
  RANK_ORDER,
} from "./confidence.js";

// Individual agents (exported for targeted use / testing)
export { reviewDataAuditor, DATA_AUDITOR_SYSTEM } from "./agents/data-auditor.js";
export {
  reviewMatchupAnalyst,
  MATCHUP_ANALYST_SYSTEM,
} from "./agents/matchup-analyst.js";
export { reviewRiskReviewer, RISK_REVIEWER_SYSTEM } from "./agents/risk-reviewer.js";

// Public API — types
export type { ReviewOptions } from "./orchestrator.js";
export type {
  ReviewProvider,
  ReasonRequest,
  ReasonOutcome,
  AnthropicProviderOptions,
} from "./provider.js";
export type {
  AgentRole,
  AgentVerdict,
  BetMarket,
  ConfidenceRank,
  DataInputs,
  EvBet,
  GamePrediction,
  InjuryNote,
  InjuryStatus,
  ModelOutputs,
  ReviewFlag,
  ReviewResult,
  Severity,
  Side,
  StartingPitcher,
  TeamRef,
  VerdictSource,
  WeatherSnapshot,
  WindDirection,
} from "./types.js";
