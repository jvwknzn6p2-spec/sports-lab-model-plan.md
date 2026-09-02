/**
 * @workspace/football-model — サッカーの試合結果モデル（Dixon-Coles）と採点。
 *
 * 純関数のみ。データ取得・台帳・封緘は持たない（それらは VORTE EV 側の規律に従って
 * 別レイヤで作る。sports-lab/football-model-plan.md）。
 */
export {
  poissonPmf,
  dixonColesTau,
  scoreMatrix,
  outcomeProbabilities,
  topScorelines,
  expectedGoals,
  bothTeamsScore,
  overTotal,
} from "./poisson.ts";
export type { ScoreMatrixOptions, OutcomeProbabilities, Scoreline } from "./poisson.ts";

export { rps, multiclassBrier, logLoss, wilson95, outcomeOf, summarize } from "./scoring.ts";
export type { Outcome, ProbabilityTriple, ScoreSummary } from "./scoring.ts";

export { fitDixonColes, predictMatch } from "./fit.ts";
export type { MatchRecord, FitOptions, FitResult, MatchPrediction } from "./fit.ts";

export { walkForward, chronological } from "./evaluate.ts";
export type { WalkForwardOptions, WalkForwardResult, WalkForwardRow } from "./evaluate.ts";
