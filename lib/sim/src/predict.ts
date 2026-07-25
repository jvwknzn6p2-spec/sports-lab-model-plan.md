/**
 * The one call the daily pipeline makes: expected runs in, a full prediction
 * card out (model-plan.md §5 step 5, §6).
 *
 * This is deliberately the only place that knows what a "standard" market looks
 * like. The simulator and the pricer below it stay market-agnostic, so adding
 * first-five-innings or an alternate handicap later is a change here, not a
 * change to the model.
 */

import {
  expectedMargin,
  expectedTotal,
  likeliestScores,
  priceHandicap,
  priceMoneyline,
  priceTotal,
} from "./markets.ts";
import { simulateGame } from "./simulate.ts";
import type { ExpectedRuns, MarketPrice, ScoreDistribution, SimulationConfig } from "./types.ts";

export interface PredictionInput {
  /** Expected runs from the baseline statistical model. */
  expected: ExpectedRuns;

  /** Stable per-game seed, e.g. `"2026-07-25:LAA@HOU"`. */
  seed: string | number;

  /** Handicap to price, applied to the home team. MLB's standard run line is 1.5. */
  runLine?: number;

  /**
   * The sportsbook's posted total.
   *
   * Optional: without it we still report expected combined runs, but there is
   * no over/under to price against and no total EV to compute.
   */
  totalLine?: number;

  /** Overrides for the run model. Defaults are MLB-calibrated. */
  config?: Partial<Omit<SimulationConfig, "seed">>;
}

export interface TwoWayMarket {
  readonly home: MarketPrice;
  readonly away: MarketPrice;
}

export interface TotalMarket {
  readonly line: number;
  readonly over: MarketPrice;
  readonly under: MarketPrice;
}

export interface GamePrediction {
  readonly distribution: ScoreDistribution;
  readonly moneyline: TwoWayMarket;
  readonly runLine: { readonly line: number } & TwoWayMarket;
  readonly total: TotalMarket | null;

  readonly expectedRuns: {
    readonly home: number;
    readonly away: number;
    readonly total: number;
    readonly margin: number;
  };

  readonly likeliestScores: ReadonlyArray<{
    readonly home: number;
    readonly away: number;
    readonly probability: number;
  }>;

  /**
   * Signals for the confidence-rank step (§4.3 / build step 7) and for the
   * Data Auditor agent (§4.5). These say how much to trust the numbers above,
   * which is separate from what the numbers say.
   */
  readonly diagnostics: {
    /** Worst-case Monte Carlo standard error across the priced markets. */
    readonly monteCarloError: number;
    /** Share of simulations that went to extra innings. */
    readonly extraInningRate: number;
    /** Simulations clamped by `maxRuns`. Non-zero means the cap is too low. */
    readonly overflow: number;
    /** Ties unresolved at the extra-innings cap. Non-zero means the cap is too low. */
    readonly forcedResolutions: number;
    readonly generatedAt: string;
    readonly inputsHash: string;
  };
}

/**
 * Run the simulation and price every standard market off the single resulting
 * distribution.
 */
export function predictGame(input: PredictionInput): GamePrediction {
  const runLine = input.runLine ?? 1.5;
  const distribution = simulateGame(input.expected, { ...input.config, seed: input.seed });

  const moneyline: TwoWayMarket = {
    home: priceMoneyline(distribution, "home"),
    away: priceMoneyline(distribution, "away"),
  };

  const runLineMarket = {
    line: runLine,
    home: priceHandicap(distribution, "home", -runLine),
    away: priceHandicap(distribution, "away", runLine),
  };

  const total: TotalMarket | null =
    input.totalLine === undefined
      ? null
      : {
          line: input.totalLine,
          over: priceTotal(distribution, "over", input.totalLine),
          under: priceTotal(distribution, "under", input.totalLine),
        };

  const errors = [
    moneyline.home.standardError,
    runLineMarket.home.standardError,
    ...(total ? [total.over.standardError] : []),
  ];

  return {
    distribution,
    moneyline,
    runLine: runLineMarket,
    total,
    expectedRuns: {
      home: distribution.meanRuns.home,
      away: distribution.meanRuns.away,
      total: expectedTotal(distribution),
      margin: expectedMargin(distribution),
    },
    likeliestScores: likeliestScores(distribution, 5),
    diagnostics: {
      monteCarloError: Math.max(...errors),
      extraInningRate: distribution.extraInningRate,
      overflow: distribution.overflow,
      forcedResolutions: distribution.forcedResolutions,
      generatedAt: distribution.generatedAt,
      inputsHash: distribution.inputsHash,
    },
  };
}
