/**
 * `@workspace/sim` — Monte Carlo simulation and market pricing.
 *
 * Build step 5 of the AI Sports Lab plan: turn the baseline model's expected
 * runs into honest probabilities, fair odds, and expected value.
 *
 * ```ts
 * const prediction = predictGame({
 *   expected: { home: 4.8, away: 4.1 },
 *   seed: "2026-07-25:LAA@HOU",
 *   totalLine: 8.5,
 * });
 * ```
 */

export { Rng, hashString } from "./rng.ts";
export { simulateGame, simsForMarginOfError, solveDispersion } from "./simulate.ts";
export {
  expectedMargin,
  expectedTotal,
  likeliestScores,
  marginDistribution,
  priceHandicap,
  priceMoneyline,
  priceTotal,
  totalDistribution,
  type TotalDirection,
} from "./markets.ts";
export {
  americanToDecimal,
  assessValue,
  bookmakerMargin,
  decimalToAmerican,
  decimalToProbability,
  expectedValue,
  kellyFraction,
  overround,
  probabilityToDecimal,
  removeVig,
  type DevigMethod,
  type ValueAssessment,
} from "./odds.ts";
export {
  predictGame,
  type GamePrediction,
  type PredictionInput,
  type TotalMarket,
  type TwoWayMarket,
} from "./predict.ts";
export {
  DEFAULT_CONFIG,
  type ExpectedRuns,
  type MarketPrice,
  type ScoreDistribution,
  type Side,
  type SimulationConfig,
} from "./types.ts";
