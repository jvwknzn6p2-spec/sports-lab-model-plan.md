/**
 * Step 5 — Monte Carlo simulation.
 *
 * Takes the baseline model's expected runs and plays the game thousands of
 * times, letting randomness decide each one. Counting the outcomes converts
 * two expected-run numbers into honest probabilities (plan Section 4.2):
 *
 *   share of sims each team wins        → moneyline
 *   share where the margin beats 1.5    → run line
 *   distribution of combined runs       → total (over/under)
 *
 * **Why not just compare expected runs?** Because 5.2 vs 4.6 expected runs is
 * not a 53% edge — baseball is noisy, and the better team loses constantly.
 * Only simulating tells you how often.
 *
 * **Why negative binomial and not Poisson?** A Poisson's variance equals its
 * mean, but real team run totals are far more spread out (a team averaging 4.4
 * runs has a variance near 9.5 — some nights they score 0, some nights 12).
 * Using Poisson would make totals look far more predictable than they are and
 * would systematically misprice over/under bets. See `RUNS_DISPERSION`.
 *
 * Runs are sampled independently for the two teams. Real games have mild
 * dependence (a blowout changes bullpen usage), which v1.0 deliberately
 * ignores for simplicity.
 */
import type { BaselineResult } from "./baseline";
import { createRng, samplePoisson, sampleNegativeBinomial, type Rng } from "./random";
import {
  DEFAULT_ITERATIONS,
  DEFAULT_RUN_LINE,
  DEFAULT_SEED,
  EXTRA_INNING_RUN_MULTIPLIER,
  MAX_EXTRA_INNINGS,
  RUNS_DISPERSION,
} from "./constants";

export interface SimulationOptions {
  /** Number of simulated games. Defaults to 10,000. */
  iterations?: number;
  /** PRNG seed. Fixed by default so results are reproducible. */
  seed?: number;
  /** Overdispersion parameter for team runs. */
  dispersion?: number;
  /** The sportsbook's posted total, e.g. 8.5. Omit to skip over/under. */
  totalLine?: number | null;
  /** Run-line spread. Defaults to MLB's standard 1.5. */
  runLine?: number;
}

export interface MoneylineProbabilities {
  home: number;
  away: number;
}

export interface RunLineProbabilities {
  /** The spread used, e.g. 1.5. */
  line: number;
  /** P(home wins by more than the line) — the "home -1.5" side. */
  homeCoversMinus: number;
  /** P(not that) — the "away +1.5" side. Complement of `homeCoversMinus`. */
  awayCoversPlus: number;
  /** P(away wins by more than the line) — the "away -1.5" side. */
  awayCoversMinus: number;
  /** P(not that) — the "home +1.5" side. */
  homeCoversPlus: number;
}

export interface TotalProbabilities {
  /** Mean combined runs across all simulations. */
  mean: number;
  /** Median combined runs — more robust than the mean for skewed totals. */
  median: number;
  /** The posted line, or null when none was supplied. */
  line: number | null;
  /** P(total > line). Null when no line was supplied. */
  over: number | null;
  /** P(total < line). Null when no line was supplied. */
  under: number | null;
  /** P(total exactly equals the line) — only possible on whole-number lines. */
  push: number | null;
}

export interface SimulationResult {
  gameId: string;
  iterations: number;
  /** The seed used, recorded so any run can be reproduced exactly. */
  seed: number;
  moneyline: MoneylineProbabilities;
  runLine: RunLineProbabilities;
  total: TotalProbabilities;
  /** Mean simulated runs per side (includes extra innings). */
  meanRuns: { home: number; away: number };
  /** Mean and median of (home runs − away runs). */
  margin: { mean: number; median: number };
  /** Share of simulations that needed extra innings. */
  extraInningsRate: number;
}

function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Median of a numeric array. Mutates by sorting a copy. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Break a regulation tie by playing extra innings until someone leads.
 * Both halves are played each inning; a walk-off would end it early in real
 * life, but the winner is the same either way.
 *
 * @returns Runs added to each side.
 */
function playExtraInnings(
  rng: Rng,
  homeMean: number,
  awayMean: number,
): { home: number; away: number } {
  // Per-inning rate, boosted for the automatic runner on second.
  const homeRate = (homeMean / 9) * EXTRA_INNING_RUN_MULTIPLIER;
  const awayRate = (awayMean / 9) * EXTRA_INNING_RUN_MULTIPLIER;

  let home = 0;
  let away = 0;
  for (let inning = 0; inning < MAX_EXTRA_INNINGS; inning++) {
    away += samplePoisson(rng, awayRate);
    home += samplePoisson(rng, homeRate);
    if (home !== away) break;
  }
  return { home, away };
}

/**
 * Run the Monte Carlo simulation for one game.
 *
 * @param baseline Output of `computeBaseline` — supplies the expected runs.
 */
export function simulateGame(
  baseline: BaselineResult,
  options: SimulationOptions = {},
): SimulationResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const seed = options.seed ?? DEFAULT_SEED;
  const dispersion = options.dispersion ?? RUNS_DISPERSION;
  const line = options.totalLine ?? null;
  const runLine = options.runLine ?? DEFAULT_RUN_LINE;

  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(`iterations must be a positive integer, got ${iterations}`);
  }

  const rng = createRng(seed);
  const homeMean = baseline.home.expectedRuns;
  const awayMean = baseline.away.expectedRuns;

  let homeWins = 0;
  let homeCoversMinus = 0;
  let awayCoversMinus = 0;
  let over = 0;
  let under = 0;
  let push = 0;
  let extraInnings = 0;
  let homeRunsSum = 0;
  let awayRunsSum = 0;

  // Kept for medians. Totals and margins are small integers, so the memory
  // cost is modest even at 10k+ iterations.
  const totals = new Array<number>(iterations);
  const margins = new Array<number>(iterations);

  for (let i = 0; i < iterations; i++) {
    let home = sampleNegativeBinomial(rng, homeMean, dispersion);
    let away = sampleNegativeBinomial(rng, awayMean, dispersion);

    // MLB has no ties — play it out.
    if (home === away) {
      extraInnings++;
      const extra = playExtraInnings(rng, homeMean, awayMean);
      home += extra.home;
      away += extra.away;
    }

    const margin = home - away;
    const total = home + away;

    homeRunsSum += home;
    awayRunsSum += away;
    totals[i] = total;
    margins[i] = margin;

    // `margin === 0` is only reachable if extras hit the MAX_EXTRA_INNINGS
    // safety bound — vanishingly rare. Award it to the home team rather than
    // dropping the iteration, so the two moneyline sides always sum to 1.
    if (margin >= 0) homeWins++;
    if (margin > runLine) homeCoversMinus++;
    if (-margin > runLine) awayCoversMinus++;

    if (line !== null) {
      if (total > line) over++;
      else if (total < line) under++;
      else push++;
    }
  }

  // Round the primary side first, then derive its complement from the
  // *rounded* value. Rounding both independently can leave the pair summing
  // to 1.0001, which would quietly corrupt the EV maths in Step 6.
  const homeWinProbability = round(homeWins / iterations);
  const homeCoversMinusProbability = round(homeCoversMinus / iterations);
  const awayCoversMinusProbability = round(awayCoversMinus / iterations);
  const overProbability = round(over / iterations);
  const pushProbability = round(push / iterations);

  return {
    gameId: baseline.gameId,
    iterations,
    seed,
    moneyline: {
      home: homeWinProbability,
      away: round(1 - homeWinProbability),
    },
    runLine: {
      line: runLine,
      homeCoversMinus: homeCoversMinusProbability,
      awayCoversPlus: round(1 - homeCoversMinusProbability),
      awayCoversMinus: awayCoversMinusProbability,
      homeCoversPlus: round(1 - awayCoversMinusProbability),
    },
    total: {
      mean: round(totals.reduce((s, t) => s + t, 0) / iterations, 3),
      median: median(totals),
      line,
      // Same reasoning as above: under is derived so the three sides total 1.
      over: line === null ? null : overProbability,
      under: line === null ? null : round(1 - overProbability - pushProbability),
      push: line === null ? null : pushProbability,
    },
    meanRuns: {
      home: round(homeRunsSum / iterations, 3),
      away: round(awayRunsSum / iterations, 3),
    },
    margin: {
      mean: round(margins.reduce((s, m) => s + m, 0) / iterations, 3),
      median: median(margins),
    },
    extraInningsRate: round(extraInnings / iterations),
  };
}

/**
 * Render the simulation as the prediction-card lines from plan Section 6.
 * Percentages only — the EV/pick logic belongs to Step 6.
 */
export function explainSimulation(
  result: SimulationResult,
  labels: { home: string; away: string },
): string[] {
  const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
  const lines = [
    `Moneyline:   ${labels.home} ${pct(result.moneyline.home)}  |  ` +
      `${labels.away} ${pct(result.moneyline.away)}`,
    `Run line:    ${labels.home} -${result.runLine.line} covers ${pct(result.runLine.homeCoversMinus)}` +
      `  |  ${labels.away} -${result.runLine.line} covers ${pct(result.runLine.awayCoversMinus)}`,
  ];

  if (result.total.line !== null && result.total.over !== null && result.total.under !== null) {
    lines.push(
      `Total:       Predicted ${result.total.mean.toFixed(1)}  (Line ${result.total.line})` +
        `  → OVER ${pct(result.total.over)} / UNDER ${pct(result.total.under)}`,
    );
  } else {
    lines.push(`Total:       Predicted ${result.total.mean.toFixed(1)}  (no line supplied)`);
  }

  return lines;
}
