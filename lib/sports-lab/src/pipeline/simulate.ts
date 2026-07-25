/**
 * Step 5: Monte Carlo simulation.
 *
 * Why not Poisson. Team runs per game are overdispersed: the mean is about 4.4
 * but the variance is about 9.3, roughly twice what Poisson would give. Using
 * Poisson would produce far too few blowouts and shutouts and would make every
 * probability drift toward 50%. We draw from a negative binomial instead, whose
 * dispersion `k` satisfies variance = mu + mu^2/k and is learned from recorded
 * results by the calibration step.
 *
 * The extra-innings correction. Drawing the two teams' runs independently
 * overstates exact ties — measured at about 10.4% of simulations against a real
 * MLB rate near 8.7%. The cause is that the two scores in a real game are not
 * independent draws (the home team's ninth inning is conditional on the score,
 * among other things). Rather than distort the run distribution to fix a
 * second-order artefact, we correct it explicitly: the surplus tie mass is
 * pushed to a one-run margin, split toward the stronger team. This leaves the
 * run distribution and the win probability essentially unchanged while making
 * the extra-innings rate — and therefore the run-line and total tails — match
 * reality. The target rate lives in `calibration.json` and is re-estimated from
 * observed games, so it is measured, not assumed.
 */

import { MLB_CONSTANTS, type ModelConstants } from "../config";
import { createRng, percentile, sampleNegativeBinomial, samplePoisson } from "../core/math";
import type { BaselineResult, Histogram, SimulationResult } from "../core/types";

function buildHistogram(values: Int16Array): Histogram {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min)) return { min: 0, counts: [], total: 0 };
  const counts = new Array<number>(max - min + 1).fill(0);
  for (const value of values) counts[value - min] = (counts[value - min] as number) + 1;
  return { min, counts, total: values.length };
}

/** P(X > threshold). */
export function probAbove(histogram: Histogram, threshold: number): number {
  if (histogram.total === 0) return 0;
  let hits = 0;
  for (let i = 0; i < histogram.counts.length; i++) {
    if (histogram.min + i > threshold) hits += histogram.counts[i] as number;
  }
  return hits / histogram.total;
}

/** P(X < threshold). */
export function probBelow(histogram: Histogram, threshold: number): number {
  if (histogram.total === 0) return 0;
  let hits = 0;
  for (let i = 0; i < histogram.counts.length; i++) {
    if (histogram.min + i < threshold) hits += histogram.counts[i] as number;
  }
  return hits / histogram.total;
}

/** P(X === value). Non-zero only for integer thresholds — i.e. a push. */
export function probEqual(histogram: Histogram, value: number): number {
  if (histogram.total === 0 || !Number.isInteger(value)) return 0;
  const index = value - histogram.min;
  if (index < 0 || index >= histogram.counts.length) return 0;
  return (histogram.counts[index] as number) / histogram.total;
}

export interface SimulationParams {
  simulations: number;
  /** Any string; the same seed always yields the same simulation. */
  seed: string;
  /** Negative-binomial dispersion for team runs. */
  dispersionK: number;
  /**
   * Empirical share of games reaching extra innings. Null disables the
   * correction and reports the raw simulated rate.
   */
  targetExtraInningsRate: number | null;
  /** Sportsbook total to evaluate. Null uses the nearest half-run to the mean. */
  totalLine: number | null;
  extraInnings: ModelConstants["extraInnings"];
}

export function defaultSimulationParams(
  overrides: Partial<SimulationParams> = {},
): SimulationParams {
  return {
    simulations: 20000,
    seed: "sports-lab",
    dispersionK: 4.2,
    targetExtraInningsRate: null,
    totalLine: null,
    extraInnings: MLB_CONSTANTS.extraInnings,
    ...overrides,
  };
}

/**
 * Resolve a tied game after nine innings, returning the runs each side adds.
 *
 * Post-2023 rules put a runner on second to start each extra half-inning, which
 * is why the per-inning run expectation here (~0.6) is well above a normal
 * inning. The home team's total is truncated at one more than the visitors',
 * because a walk-off ends the inning.
 */
function playExtraInnings(
  rng: { next(): number },
  params: SimulationParams,
): { homeAdds: number; awayAdds: number; innings: number } {
  let homeAdds = 0;
  let awayAdds = 0;
  const max = Math.max(1, params.extraInnings.maxInnings);
  for (let inning = 1; inning <= max; inning++) {
    const away = samplePoisson(rng, params.extraInnings.awayRunsPerInning);
    const home = samplePoisson(rng, params.extraInnings.homeRunsPerInning);
    awayAdds += away;
    if (away > home) {
      homeAdds += home;
      return { homeAdds, awayAdds, innings: inning };
    }
    // Walk-off: the home team stops batting the moment it leads.
    const effectiveHome = home > away ? away + 1 : home;
    homeAdds += effectiveHome;
    if (effectiveHome > away) return { homeAdds, awayAdds, innings: inning };
  }
  // Still tied after the cap — break it rather than report a tie MLB never has.
  if (rng.next() < 0.53) homeAdds += 1;
  else awayAdds += 1;
  return { homeAdds, awayAdds, innings: max };
}

export function simulateGame(
  baseline: BaselineResult,
  params: SimulationParams,
): SimulationResult {
  const n = Math.max(1000, Math.trunc(params.simulations));
  const muHome = Math.max(0.05, baseline.teams.home.expectedRuns);
  const muAway = Math.max(0.05, baseline.teams.away.expectedRuns);
  const k = params.dispersionK;

  // Pass 1: nine-inning scores. Stored so the tie correction can be applied
  // with the raw tie rate known, without re-drawing (which would change the
  // sample and make the correction unverifiable).
  const rng = createRng(`${params.seed}|runs`);
  const home9 = new Int16Array(n);
  const away9 = new Int16Array(n);
  let rawTies = 0;
  for (let i = 0; i < n; i++) {
    const h = sampleNegativeBinomial(rng, muHome, k);
    const a = sampleNegativeBinomial(rng, muAway, k);
    home9[i] = h;
    away9[i] = a;
    if (h === a) rawTies++;
  }

  const rawTieRate = rawTies / n;
  const target = params.targetExtraInningsRate;
  const breakFraction =
    target !== null && rawTieRate > 0 && target < rawTieRate
      ? (rawTieRate - target) / rawTieRate
      : 0;
  // Ties broken toward the stronger team, but only just — a one-run game is
  // close to a coin flip regardless of the run expectations.
  const homeTieShare = 0.5 + 0.5 * ((muHome - muAway) / (muHome + muAway));

  // Pass 2: apply the correction, play out real ties, and accumulate.
  const rng2 = createRng(`${params.seed}|resolve`);
  let homeWins = 0;
  let homeCover = 0;
  let awayCover = 0;
  let extras = 0;
  let totalSum = 0;
  let marginSum = 0;
  const totals = new Int16Array(n);
  const margins = new Int16Array(n);

  const line =
    params.totalLine !== null
      ? params.totalLine
      : Math.round((muHome + muAway) * 2) / 2;
  let over = 0;
  let under = 0;
  let push = 0;

  for (let i = 0; i < n; i++) {
    let h = home9[i] as number;
    let a = away9[i] as number;

    if (h === a) {
      if (breakFraction > 0 && rng2.next() < breakFraction) {
        if (rng2.next() < homeTieShare) h += 1;
        else a += 1;
      } else {
        const extra = playExtraInnings(rng2, params);
        h += extra.homeAdds;
        a += extra.awayAdds;
        extras++;
      }
    }

    const total = h + a;
    const margin = h - a;
    totals[i] = total;
    margins[i] = margin;
    totalSum += total;
    marginSum += margin;
    if (margin > 0) homeWins++;
    if (margin >= 2) homeCover++;
    if (margin <= 1) awayCover++;
    if (total > line) over++;
    else if (total < line) under++;
    else push++;
  }

  const homeWinProb = homeWins / n;
  const totalsArray = Array.from(totals);
  const marginsArray = Array.from(margins);

  return {
    simulations: n,
    seed: params.seed,
    winProbability: { home: homeWinProb, away: 1 - homeWinProb },
    homeCoversMinus1p5: homeCover / n,
    awayCoversPlus1p5: awayCover / n,
    meanTotal: totalSum / n,
    meanMargin: marginSum / n,
    extraInningsRate: extras / n,
    winProbStdError: Math.sqrt((homeWinProb * (1 - homeWinProb)) / n),
    totalDistribution: { line, over: over / n, under: under / n, push: push / n },
    percentiles: {
      total: {
        p10: percentile(totalsArray, 0.1),
        p50: percentile(totalsArray, 0.5),
        p90: percentile(totalsArray, 0.9),
      },
      margin: {
        p10: percentile(marginsArray, 0.1),
        p50: percentile(marginsArray, 0.5),
        p90: percentile(marginsArray, 0.9),
      },
    },
    marginHistogram: buildHistogram(margins),
    totalHistogram: buildHistogram(totals),
  };
}

/** Deterministic per-game seed, so re-running a date reproduces it exactly. */
export function seedForGame(gamePk: number, date: string, modelVersion: string): string {
  return `${modelVersion}|${date}|${gamePk}`;
}
