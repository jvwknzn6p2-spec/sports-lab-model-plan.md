/**
 * Walk-forward backtest — the production pipeline replayed over REAL history.
 *
 * Same feature assembly, same run model, same seeded simulator, same banded
 * calibration, same settlement: the only thing that differs from production
 * is the data source, which must answer every query AS OF the day being
 * predicted (point-in-time stats, no look-ahead). The calibration state walks
 * forward exactly as production's does — day D's picks are calibrated only by
 * days < D, then D settles and joins the history the next day learns from.
 *
 * What this deliberately does NOT do:
 *   - invent handicap lines: no historical market prices exist in the MLB
 *     feed, and fabricated ones would poison every conclusion. Every game is
 *     evaluated at the same 0-line the production book has run so far, so
 *     backtest results validate the MODEL (probabilities, spread,
 *     calibration) — never a market edge.
 *   - fabricate missing inputs: a day without a probable starter or stats
 *     degrades through the exact flags production uses.
 */

import type {
  CalibrationState,
  DecisionConfig,
  GamePrediction,
} from "./decision";
import { decide, DEFAULT_DECISION_CONFIG } from "./decision";
import { expectedRuns } from "./run-model";
import {
  recalibrateFromHistory,
  settle,
  type GameResult,
  type SettlementReport,
} from "./settle";
import { simulateGame, type SimulateOptions } from "./simulate";
import type { GameCoreData } from "../step2";

/**
 * Simulator overrides for parameter-candidate replays. Omitted fields use
 * the production constants, so a plain backtest IS the production engine.
 */
export type SimParams = Pick<SimulateOptions, "dispersion" | "envSd">;

/** Predict one slate exactly the way cmdPredict does, minus I/O. */
export function predictSlate(
  date: string,
  games: GameCoreData[],
  calibration: CalibrationState,
  season: number,
  sims: number,
  cfg: DecisionConfig = DEFAULT_DECISION_CONFIG,
  simParams: SimParams = {},
): GamePrediction[] {
  return games.map((g) => {
    const runs = expectedRuns(g, season);
    const sim = simulateGame(runs.homeMu, runs.awayMu, {
      sims,
      seed: `${date}:${g.gamePk}`,
      ...simParams,
    });
    return decide(
      g,
      runs,
      sim,
      calibration,
      { side: "home", notation: "0" },
      cfg,
    );
  });
}

export interface BacktestDay {
  date: string;
  games: GameCoreData[];
  /** Final scores keyed by gamePk (Final games only). */
  results: Record<string, GameResult>;
}

export interface BacktestOutcome {
  reports: SettlementReport[];
  calibration: CalibrationState;
  /** Per-day locked predictions, for distribution checks downstream. */
  predictions: Map<string, GamePrediction[]>;
}

/**
 * Replay days in order. Days must be pre-sorted ascending; each day's
 * predictions see only the calibration learned from the days before it.
 */
export function walkForward(
  days: BacktestDay[],
  base: CalibrationState,
  season: number,
  sims: number,
  cfg: DecisionConfig = DEFAULT_DECISION_CONFIG,
  simParams: SimParams = {},
): BacktestOutcome {
  const reports: SettlementReport[] = [];
  const predictions = new Map<string, GamePrediction[]>();
  let calibration = base;

  for (const day of days) {
    const preds = predictSlate(day.date, day.games, calibration, season, sims, cfg, simParams);
    predictions.set(day.date, preds);
    const report = settle(
      day.date,
      preds,
      day.results,
      calibration,
      // A fixed instant keeps the replay deterministic; only updatedAt uses it.
      new Date(`${day.date}T23:59:59Z`),
    );
    reports.push(report);
    calibration = recalibrateFromHistory(
      reports,
      base,
      new Date(`${day.date}T23:59:59Z`),
    );
  }

  return { reports, calibration, predictions };
}
