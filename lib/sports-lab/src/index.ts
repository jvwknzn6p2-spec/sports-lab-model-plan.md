/**
 * @workspace/sports-lab — Step 3: context data + validation/flagging layer.
 *
 * Public surface:
 *   - schemas: zod schemas + inferred types for the context-data contract.
 *   - context helpers: recent form, injuries, weather, ballpark factors.
 *   - validate: the flagging layer that turns data gaps into typed flags and
 *     a confidence cap ("fail loudly, not silently").
 */
export * from "./schemas";
export * from "./flags";
export * from "./validate";

// Steps 1–2 — MLB Stats API ingest.
export {
  MlbClient,
  MlbApiError,
  MLB_API_BASE,
  type FetchLike,
  type MlbClientOptions,
} from "./sources/mlb/client";
export {
  fetchCoreGames,
  fetchSchedule,
  fetchStartingPitcher,
  fetchTeamBatting,
  fetchBullpen,
  fetchRecentForm,
  fetchTeamAbbreviations,
  seasonForDate,
  shiftDate,
  type FetchCoreGamesOptions,
  type FetchCoreGamesResult,
} from "./sources/mlb/fetch";
export {
  parseInningsPitched,
  parseStatNumber,
  firstSplitStat,
} from "./sources/mlb/responses";

// Step 11 — the daily workflow.
export {
  runDailyPipeline,
  seedForGame,
  type PipelineFailure,
  type PipelineOptions,
  type PipelineResult,
  type RunMode,
  type SlateEntry,
} from "./pipeline";

// Step 10 — daily report and structured log.
export {
  renderDailyReport,
  renderDailySummary,
  renderGameCard,
  sortByConfidence,
  keyFactors,
  finalRank,
  toDailyLog,
  serializeDailyLog,
  type DailyLog,
  type GamePrediction,
  type LoggedGame,
  type ReportMeta,
  type ReportOptions,
} from "./report";

// Step 9 — AI multi-agent review.
export {
  reviewGame,
  applyReview,
  explainReview,
  REVIEW_AGENTS,
  type ReviewFailure,
  type ReviewOptions,
  type ReviewOutcome,
} from "./review/review";
export {
  createClaudeReviewer,
  ruleBasedReviewer,
  ReviewError,
  type ClaudeReviewerOptions,
  type Reviewer,
} from "./review/reviewers";
export {
  buildDossier,
  roleBrief,
  type DossierInputs,
} from "./review/prompts";
export {
  reviewVerdictSchema,
  reviewAgentSchema,
  assessmentSchema,
  REVIEW_VERDICT_JSON_SCHEMA,
  type Assessment,
  type ReviewAgent,
  type ReviewVerdict,
} from "./review/schemas";

// Step 8 — backtesting.
export {
  runBacktest,
  settleBet,
  betProfit,
  toPredictionRecord,
  explainBacktest,
  type BacktestOptions,
  type BacktestReport,
  type BacktestSummary,
  type BetOutcome,
  type CalibrationBin,
  type PredictionRecord,
  type SettledBet,
} from "./backtest";

// Step 7 — confidence ranking.
export {
  assignConfidence,
  rankGames,
  explainConfidence,
  type ConfidenceAssessment,
  type ConfidenceFactor,
  type ConfidenceInputs,
  type FactorImpact,
} from "./confidence";

export { computeRecentForm } from "./context/recent-form";
export { lookupBallparkFactors, SEED_PARK_COUNT } from "./context/ballpark";
export {
  deriveWindRelative,
  isForecastStale,
  roofNeutralizesWeather,
  CALM_WIND_MPH,
} from "./context/weather";
export { ruledOut, materialAbsences, hasMaterialAbsence } from "./context/injuries";
export { assembleGameContext, type ContextParts } from "./context/assemble";

// Step 4 — baseline statistical model.
export {
  computeBaseline,
  explainEstimate,
  BaselineInputError,
  type AdjustmentStep,
  type BaselineResult,
  type TeamRunEstimate,
} from "./model/baseline";
export * as baselineConstants from "./model/constants";

// Step 5 — Monte Carlo simulation.
export {
  simulateGame,
  explainSimulation,
  type SimulationOptions,
  type SimulationResult,
  type MoneylineProbabilities,
  type RunLineProbabilities,
  type TotalProbabilities,
} from "./model/simulate";
export { createRng, type Rng } from "./model/random";

// Step 6 — betting odds and expected value.
export {
  americanToDecimal,
  decimalToAmerican,
  impliedProbability,
  overround,
  removeVig,
  removeVigAmerican,
  InvalidOddsError,
  type AmericanOdds,
} from "./odds/conversion";
export {
  evaluateOdds,
  expectedValue,
  explainEvaluation,
  type BetEvaluation,
  type BetMarket,
  type BetSelection,
  type EvOptions,
  type GameEvaluation,
} from "./odds/ev";
