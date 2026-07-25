/**
 * @workspace/sports-lab — MLB game prediction pipeline.
 *
 * See `sports-lab/model-plan.md` at the repo root for the design this
 * implements, and `lib/sports-lab/README.md` for how to run it.
 */

export { MODEL_VERSION, MLB_CONSTANTS, loadRuntimeConfig, SOURCE_URLS } from "./config";
export type { ModelConstants, RuntimeConfig } from "./config";

export * from "./core/types";
export { IssueCollector, ISSUE_CODES } from "./core/issues";
export { addDays, assertGameDate, dateRange, today } from "./core/dates";

export { Collector, createSources } from "./pipeline/collect";
export type { SourceBundle, CollectionOutput } from "./pipeline/collect";
export { assessDataQuality } from "./pipeline/validate";
export { runBaseline, componentRunsPerGame, weatherMultiplier } from "./pipeline/baseline";
export {
  simulateGame,
  defaultSimulationParams,
  seedForGame,
  probAbove,
  probBelow,
  probEqual,
} from "./pipeline/simulate";
export type { SimulationParams } from "./pipeline/simulate";
export {
  americanToDecimal,
  decimalToAmerican,
  impliedProbability,
  devig,
  evaluateBet,
  evaluateGameBets,
} from "./pipeline/ev";
export { assessConfidence, offenseEstimatorSpread } from "./pipeline/confidence";
export { predictDate, predictGame } from "./pipeline/predict";

export { gradeDay, summariseGrading } from "./loop/score";
export { analyseGraded } from "./loop/analyze";
export { fitCalibration, dispersionFromMoments } from "./loop/calibrate";
export {
  DEFAULT_CALIBRATION,
  calibrateTotal,
  calibrateWinProbability,
  shrinkTowardDefault,
} from "./loop/calibration";

export { Store } from "./store/store";
export type { GradedDay } from "./store/store";

export { formatDailyReport, formatGameCard, formatAnalysis } from "./report/text";
