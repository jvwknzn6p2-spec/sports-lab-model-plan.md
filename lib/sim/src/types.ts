/**
 * Shared types for the Monte Carlo layer (model-plan.md §4.2).
 *
 * The boundary is deliberately narrow: the baseline statistical model (§4.1)
 * hands us two expected-run numbers, and we hand back a full joint
 * distribution of final scores. Everything downstream — moneyline, run line,
 * totals, Asian handicaps, EV — is priced from that one distribution.
 */

/** Which side of a two-way market a price refers to. */
export type Side = "home" | "away";

/** Output of the baseline model: expected runs for each side, park/weather/pitching already applied. */
export interface ExpectedRuns {
  /** Expected runs for the home team over a regulation game. */
  home: number;
  /** Expected runs for the away team over a regulation game. */
  away: number;
}

/**
 * Knobs for the run-generating process.
 *
 * The defaults are calibrated to modern MLB (mean ≈ 4.5 runs, variance ≈ 9.5).
 * NPB scores slightly lower and with slightly less spread; override
 * `dispersionK` per league rather than editing these.
 */
export interface SimulationConfig {
  /** Number of games to simulate. 10,000 is the plan's default; see `simsForMarginOfError`. */
  sims: number;

  /** Seed. Use something stable and game-specific, e.g. `"2026-07-25:ORIX@CHIB"`. */
  seed: string | number;

  /**
   * Negative-binomial dispersion. Team run variance is `mu + mu^2 / dispersionK`.
   *
   * Runs are NOT Poisson — a Poisson model would claim variance equals the mean
   * (≈4.5) when the real variance is roughly 9.5. That understates the tails
   * badly and is the single most common way a naive simulator misprices totals
   * and run lines. `4.05` reproduces the observed MLB spread.
   */
  dispersionK: number;

  /**
   * Correlation between the two teams' run totals.
   *
   * Weather, ballpark, altitude and the strike zone push both teams the same
   * direction, so scores are mildly positively correlated. Ignoring this makes
   * the simulated distribution of *combined* runs too narrow, which
   * systematically overprices totals near the line.
   */
  environmentCorrelation: number;

  /**
   * Whether the home team's half of the ninth is skipped when they already lead.
   *
   * A real home team that is ahead after the top of the ninth does not bat.
   * Simulating a full nine for both sides inflates expected totals by roughly
   * 0.2 runs — enough to flip over/under calls on their own.
   */
  homeNinthTruncation: boolean;

  /**
   * Scoring rate multiplier for extra innings, relative to a normal half-inning.
   *
   * Both MLB (permanently) and NPB (situationally) start extra innings with a
   * runner already in scoring position, which lifts run expectancy well above a
   * standard inning.
   */
  extraInningBoost: number;

  /**
   * Safety valve: extra innings simulated before a still-tied game is resolved
   * by a coin flip.
   *
   * This is not a model of any league's drawn-game rule — it exists so a
   * pathological input cannot hang the loop. At the default of 20 it never
   * fires in practice (zero occurrences in 300,000 simulated games), and
   * `forcedResolutions` reports it if it ever does.
   */
  maxExtraInnings: number;

  /** Largest run total tracked per team. Scores above this are clamped and counted in `overflow`. */
  maxRuns: number;
}

export const DEFAULT_CONFIG: Omit<SimulationConfig, "seed"> = {
  sims: 10_000,
  dispersionK: 4.05,
  environmentCorrelation: 0.05,
  homeNinthTruncation: true,
  extraInningBoost: 1.4,
  maxExtraInnings: 20,
  maxRuns: 40,
};

/**
 * The result of simulating one game many times.
 *
 * `joint[home * stride + away]` is the number of simulations that ended with
 * exactly that score. Keeping the whole matrix rather than three summary
 * numbers is what lets us price an arbitrary handicap or total afterwards
 * without re-simulating.
 */
export interface ScoreDistribution {
  readonly sims: number;
  readonly seed: string | number;
  readonly stride: number;
  readonly joint: Int32Array;

  /** Simulations whose score was clamped by `maxRuns`. Should be ~0; investigate if not. */
  readonly overflow: number;

  /** Games still tied at `maxExtraInnings` and resolved arbitrarily. Should be ~0. */
  readonly forcedResolutions: number;

  /** Mean simulated runs, after truncation and extra innings. */
  readonly meanRuns: { home: number; away: number };

  /** Variance of simulated runs. Sanity-check against `mu + mu^2 / dispersionK`. */
  readonly varianceRuns: { home: number; away: number };

  /** Realised correlation between the two teams' scores. */
  readonly runCorrelation: number;

  /** Share of games that needed extra innings. Historically ≈ 8–9%. */
  readonly extraInningRate: number;

  /** ISO timestamp — the plan requires every prediction to be timestamped for backtesting. */
  readonly generatedAt: string;

  /** Hash of the inputs that produced this distribution, for cache keys and drift tracking. */
  readonly inputsHash: string;
}

/**
 * A price for one selection.
 *
 * `win + push + loss === 1`. Push is separated out rather than folded into the
 * loss because a pushed bet returns the stake, which changes the fair odds.
 */
export interface MarketPrice {
  readonly win: number;
  readonly push: number;
  readonly loss: number;

  /** Break-even decimal odds. Anything longer than this is a positive-EV price. */
  readonly fairDecimal: number;

  /** The same number in American format, for books that quote that way. */
  readonly fairAmerican: number;

  /**
   * Monte Carlo standard error on `win`.
   *
   * Reported so a "+1.1% edge" can be checked against the noise floor of the
   * simulation itself. At 10,000 sims that floor is ±0.5% on a coin-flip
   * market, so a sub-1% edge is not distinguishable from nothing.
   */
  readonly standardError: number;

  readonly sims: number;
}
