/**
 * Loop stage 3: improve.
 *
 * This is the only place in the codebase that learns from results. It reads
 * graded games and writes `calibration.json`, which `predict` picks up on its
 * next run. That is the whole loop: predict -> record -> analyse -> improve ->
 * predict.
 *
 * The governing principle is shrinkage. A fit from 60 games is mostly noise, and
 * a loop that trusts it will chase its own variance and get worse. Every fitted
 * parameter is therefore blended toward its default with a weight of
 * n / (n + k), so early fits barely move and only a real, sustained bias
 * accumulates enough evidence to shift the model.
 *
 * What is fitted:
 *   moneyline (a, b)    Platt scaling in logit space, from actual outcomes
 *   totals bias         mean predicted total minus mean actual total
 *   extraInningsRate    observed share of games reaching extras
 *   runDispersionK      dispersion implied by the observed variance of team runs
 *
 * What is NOT fitted, deliberately: the confidence thresholds. Tuning them on
 * the same games used to measure them is how a backtest starts lying. They move
 * only when a human reads the rank breakdown and decides to move them.
 */

import { fitPlattScaling, mean } from "../core/math";
import type { Calibration, GameDate, GradedGame } from "../core/types";
import { DEFAULT_CALIBRATION, shrinkTowardDefault } from "./calibration";

/** Games needed before a parameter is fitted at all. */
export const MIN_GAMES_TO_FIT = 60;

/** Half-weight sample sizes: the fit reaches 50% influence at these counts. */
const SHRINK_K = {
  moneyline: 400,
  totals: 250,
  extraInnings: 500,
  dispersion: 400,
} as const;

export interface CalibrationFit {
  calibration: Calibration;
  /** Human-readable account of what moved and why. */
  changes: string[];
  /** Reasons a parameter was left at its previous value. */
  skipped: string[];
}

/**
 * Dispersion k implied by an observed mean and variance of team-game runs,
 * from variance = mu + mu^2 / k. Returns null when the data is underdispersed
 * (variance <= mean), where a negative binomial cannot fit and Poisson is
 * already the limiting case.
 */
export function dispersionFromMoments(
  observedMean: number,
  observedVariance: number,
): number | null {
  if (!Number.isFinite(observedMean) || !Number.isFinite(observedVariance)) return null;
  if (observedMean <= 0) return null;
  const excess = observedVariance - observedMean;
  if (excess <= 0.05) return null;
  return (observedMean * observedMean) / excess;
}

export function fitCalibration(
  games: GradedGame[],
  previous: Calibration,
  from: GameDate,
  to: GameDate,
): CalibrationFit {
  const changes: string[] = [];
  const skipped: string[] = [];
  const n = games.length;

  if (n < MIN_GAMES_TO_FIT) {
    return {
      calibration: {
        ...previous,
        notes: [
          `Not refitted: only ${n} graded games, minimum is ${MIN_GAMES_TO_FIT}.`,
          ...previous.notes.filter((note) => !note.startsWith("Not refitted:")),
        ],
      },
      changes: [],
      skipped: [
        `Only ${n} graded games; need ${MIN_GAMES_TO_FIT} before fitting anything. ` +
          `Keep running the daily loop.`,
      ],
    };
  }

  // --- moneyline (Platt scaling) --------------------------------------------
  const platt = fitPlattScaling(
    games.map((g) => g.homeWinProbability),
    games.map((g) => g.homeWon),
  );
  let moneyline = previous.moneyline;
  if (platt.converged) {
    const a = shrinkTowardDefault(platt.a, 1, n, SHRINK_K.moneyline);
    const b = shrinkTowardDefault(platt.b, 0, n, SHRINK_K.moneyline);
    moneyline = { a, b };
    changes.push(
      `moneyline Platt a=${a.toFixed(3)} b=${b.toFixed(3)} ` +
        `(raw fit a=${platt.a.toFixed(3)} b=${platt.b.toFixed(3)}, shrunk for n=${n})`,
    );
  } else {
    skipped.push("moneyline Platt fit did not converge — left unchanged");
  }

  // --- totals bias ----------------------------------------------------------
  const predictedTotals = games.map((g) => g.predictedTotal);
  const actualTotals = games.map((g) => g.actualTotal);
  const predictedMean = mean(predictedTotals);
  const actualMean = mean(actualTotals);
  let totals = previous.totals;
  if (predictedMean !== null && actualMean !== null) {
    const rawBias = actualMean - predictedMean;
    const bias = shrinkTowardDefault(rawBias, 0, n, SHRINK_K.totals);
    totals = { ...previous.totals, bias };
    changes.push(
      `totals bias ${bias >= 0 ? "+" : ""}${bias.toFixed(3)} runs ` +
        `(observed gap ${rawBias >= 0 ? "+" : ""}${rawBias.toFixed(3)}, shrunk for n=${n})`,
    );
  }

  // --- extra-innings rate ---------------------------------------------------
  const observedExtras = games.filter((g) => g.result.wentToExtras).length / n;
  const extraInningsRate = shrinkTowardDefault(
    observedExtras,
    DEFAULT_CALIBRATION.extraInningsRate,
    n,
    SHRINK_K.extraInnings,
  );
  changes.push(
    `extra-innings target ${(extraInningsRate * 100).toFixed(2)}% ` +
      `(observed ${(observedExtras * 100).toFixed(2)}% over ${n} games)`,
  );

  // --- run dispersion -------------------------------------------------------
  // Both teams' scores from every graded game, treated as one sample of the
  // team-game run distribution.
  const teamRuns = games.flatMap((g) => [g.result.homeScore, g.result.awayScore]);
  const runsMean = mean(teamRuns);
  let runDispersionK = previous.runDispersionK;
  if (runsMean !== null && teamRuns.length > 2) {
    const variance =
      teamRuns.reduce((sum, r) => sum + (r - runsMean) ** 2, 0) / (teamRuns.length - 1);
    const implied = dispersionFromMoments(runsMean, variance);
    if (implied !== null) {
      runDispersionK = shrinkTowardDefault(
        implied,
        DEFAULT_CALIBRATION.runDispersionK,
        n,
        SHRINK_K.dispersion,
      );
      changes.push(
        `run dispersion k=${runDispersionK.toFixed(2)} ` +
          `(observed mean ${runsMean.toFixed(2)}, variance ${variance.toFixed(2)} ` +
          `implies k=${implied.toFixed(2)})`,
      );
    } else {
      skipped.push(
        "observed run variance is not above the mean — dispersion left unchanged",
      );
    }
  }

  skipped.push(
    "confidence thresholds are never auto-tuned: fitting them on the games used " +
      "to measure them would make the rank breakdown self-fulfilling",
  );

  const now = new Date().toISOString();
  return {
    calibration: {
      version: `fitted/${to}/n${n}`,
      sport: "MLB",
      fittedAt: now,
      sampleGames: n,
      fittedRange: { from, to },
      moneyline,
      totals,
      extraInningsRate,
      runDispersionK,
      confidenceThresholds: previous.confidenceThresholds,
      notes: [
        `Fitted from ${n} graded games between ${from} and ${to}.`,
        "Fitted values are shrunk toward the defaults by sample size; early fits " +
          "move very little on purpose.",
        "Confidence thresholds carried over unchanged — adjust them by hand from " +
          "the rank breakdown in `analyze`.",
      ],
    },
    changes,
    skipped,
  };
}
