/**
 * The calibration file is the memory of the loop.
 *
 * `predict` reads it, `score` and `analyze` measure against it, and `calibrate`
 * rewrites it. Nothing else in the pipeline is allowed to hold learned
 * parameters — if a number improves because we saw results, it lives here.
 *
 * The defaults below are league-level starting points, and they say so:
 * `sampleGames: 0` means nothing has been fitted yet, which the confidence step
 * treats as a reason to withhold S ranks entirely.
 */

import { logit, sigmoid } from "../core/math";
import type { Calibration } from "../core/types";

export const DEFAULT_CALIBRATION: Calibration = {
  version: "defaults/unfitted",
  sport: "MLB",
  fittedAt: null,
  sampleGames: 0,
  fittedRange: null,
  // Identity: the raw simulation is used as-is until results say otherwise.
  moneyline: { a: 1, b: 0 },
  totals: { bias: 0, scale: 1, pivot: 8.5 },
  /**
   * Observed MLB rate of games reaching extra innings, roughly 8.7% in the
   * automatic-runner era. Independent negative-binomial draws produce closer to
   * 10.4%, so simulate.ts corrects toward this number. Re-estimated from
   * recorded results once enough games are graded.
   */
  extraInningsRate: 0.087,
  /**
   * Negative-binomial dispersion for team runs. k = 4.2 gives variance
   * mu + mu^2/4.2, which is about 9.0 at mu = 4.4 — matching the observed
   * variance of MLB team-game run totals.
   */
  runDispersionK: 4.2,
  confidenceThresholds: { S: 72, A: 58, B: 42 },
  notes: [
    "Unfitted defaults. League-level constants, not learned from this model's own results.",
    "Run `pnpm --filter @workspace/sports-lab run calibrate -- --write` once games have been scored.",
  ],
};

/** Platt scaling in logit space. Identity when a = 1, b = 0. */
export function calibrateWinProbability(raw: number, calibration: Calibration): number {
  const { a, b } = calibration.moneyline;
  if (a === 1 && b === 0) return raw;
  return sigmoid(a * logit(raw) + b);
}

/** Bias and scale correction on the predicted total. */
export function calibrateTotal(raw: number, calibration: Calibration): number {
  const { bias, scale, pivot } = calibration.totals;
  if (bias === 0 && scale === 1) return raw;
  return scale * (raw - pivot) + pivot + bias;
}

/**
 * Blend a freshly fitted calibration toward the identity/default by sample size.
 *
 * With 40 graded games a fitted Platt slope is mostly noise; with 800 it is
 * mostly signal. `k` is the number of games at which the fit gets half weight.
 * Shrinking here is the difference between a loop that improves and a loop that
 * chases its own variance.
 */
export function shrinkTowardDefault(
  fitted: number,
  fallback: number,
  sampleGames: number,
  k = 400,
): number {
  if (sampleGames <= 0) return fallback;
  const weight = sampleGames / (sampleGames + k);
  return weight * fitted + (1 - weight) * fallback;
}
