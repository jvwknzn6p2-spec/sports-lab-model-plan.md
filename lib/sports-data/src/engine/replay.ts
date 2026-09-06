/**
 * Replay a committed prediction lock from its committed input slate with the
 * CURRENT code — the candidate side of a PR evaluation.
 *
 * What makes this as-of by construction:
 *   - the input is the slate file `fetch-slate` wrote before the lock (its
 *     `fetchedAt` is the latest instant any input could have been observed);
 *   - the calibration state is the one recorded IN the lock, cross-checked
 *     against a recomputation from history rows strictly before the date;
 *   - handicap lines and decision config come from the lock's control tower;
 *   - the simulator is seeded `${date}:${gamePk}` exactly as production.
 *
 * What it is NOT: proof that the production pick was made in time. A replay
 * carries `replayedAt` and `sealedAt`, never `predictedAt`, and is tagged
 * `source: "replay"` so it can never be mistaken for a production lock.
 */

import { createHash } from "node:crypto";

import { assembleDate } from "../step2";
import { registerSeasonConstants } from "../sabermetrics";
import { FixtureCoreDataSource, type FixtureBundle } from "../sources/fixture-source";
import {
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
  normalizeCalibration,
  type CalibrationState,
  type GamePrediction,
  type HandicapInput,
} from "./decision";
import { expectedRuns } from "./run-model";
import { recalibrateFromHistory, type SettlementReport } from "./settle";
import { simulateGame, type SimulateOptions } from "./simulate";

export type SimParams = Pick<SimulateOptions, "dispersion" | "envSd">;

export interface ReplayLockInput {
  lockedAt: string;
  updatedAt?: string;
  controlTower: {
    date: string;
    season: number;
    sims?: number;
    passThreshold?: number;
    minEv?: number;
    handicaps?: Record<string, HandicapInput>;
  };
  calibration: CalibrationState;
  predictions: GamePrediction[];
}

export interface ReplayOutput {
  source: "replay";
  league: "mlb" | "npb";
  date: string;
  replayedAt: string;
  /** git commit of the code that produced this replay */
  codeVersion: string;
  replayOf: { lockedAt: string; updatedAt: string | null; predictions: number };
  input: { slateFetchedAt: string | null; slateSha256: string };
  calibration: CalibrationState;
  /**
   * Was the lock's calibration exactly what history rows BEFORE this date
   * produce? `verified: false` means the lock may have been rewritten with a
   * state that had already seen results from this date or later — such rows
   * are excluded from performance evidence. `null` when there is no history.
   */
  calibrationAsOf: { verified: boolean | null; historyRowsBefore: number; differences: string[] };
  engine: { sims: number; passThreshold: number; minEv: number; simParams: SimParams };
  /**
   * How many of the production lock's stated probabilities this replay
   * reproduced exactly, and for how many picks the committed slate is
   * provably the input they were computed from (`inputSha256`; null when
   * the lock predates that stamp). A pick whose input differs cannot be
   * expected to reproduce — the slate was re-fetched after it was frozen.
   */
  reproduction: { matched: number; compared: number; inputMatched: number | null };
  /** sha256 over the predictions array, taken before any result was read. */
  predictionsSha256: string;
  sealedAt: string;
  predictions: GamePrediction[];
}

const SHRINK_FIELDS = [
  "shrink", "tailShrink", "farTailShrink",
  "handicapShrink", "handicapTailShrink", "handicapFarTailShrink",
  "totalShrink", "totalTailShrink", "totalFarTailShrink",
] as const;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Compare the lock's calibration with the state history rows before `date` yield. */
export function calibrationAsOfCheck(
  lockCalibration: CalibrationState,
  history: SettlementReport[],
  date: string,
): ReplayOutput["calibrationAsOf"] {
  const before = history.filter((r) => r.date < date);
  if (before.length === 0) return { verified: null, historyRowsBefore: 0, differences: [] };
  const expected = recalibrateFromHistory(before, DEFAULT_CALIBRATION, new Date(0));
  const differences = SHRINK_FIELDS.filter((f) => Math.abs(expected[f] - lockCalibration[f]) > 1e-9).map(
    (f) => `${f}: lock ${lockCalibration[f]} vs history-before-date ${expected[f]}`,
  );
  return { verified: differences.length === 0, historyRowsBefore: before.length, differences };
}

export async function replayLock(opts: {
  league: "mlb" | "npb";
  lock: ReplayLockInput;
  bundle: FixtureBundle;
  bundleText: string;
  history: SettlementReport[];
  codeVersion: string;
  now: Date;
  simParams?: SimParams;
}): Promise<ReplayOutput> {
  const { lock, bundle } = opts;
  const ct = lock.controlTower;
  // Production loads its state through normalizeCalibration (a lock written
  // before the far-tail split lacks farTailShrink; the default fills it).
  // Using the raw object would turn every far-tail pick into NaN.
  const calibration = normalizeCalibration(lock.calibration);
  if (bundle.leagueConstants) registerSeasonConstants(bundle.leagueConstants);
  const games = await assembleDate(ct.date, new FixtureCoreDataSource(bundle), { season: ct.season });
  const cfg = {
    ...DEFAULT_DECISION_CONFIG,
    ...(ct.passThreshold !== undefined ? { passThreshold: ct.passThreshold } : {}),
    ...(ct.minEv !== undefined ? { minEv: ct.minEv } : {}),
  };
  const sims = ct.sims ?? 10_000;
  const simParams = opts.simParams ?? {};
  const byPk = new Map(lock.predictions.map((p) => [p.gamePk, p]));
  const predictions: GamePrediction[] = [];
  const slateSha = sha256(opts.bundleText);
  let matched = 0;
  let compared = 0;
  let inputMatched: number | null = null;
  for (const g of games) {
    if (!byPk.has(g.gamePk)) continue; // only games the production lock actually scored
    const runs = expectedRuns(g, ct.season);
    const sim = simulateGame(runs.homeMu, runs.awayMu, { sims, seed: `${ct.date}:${g.gamePk}`, ...simParams });
    const p = decide(g, runs, sim, calibration, ct.handicaps?.[String(g.gamePk)] ?? null, cfg);
    const prod = byPk.get(g.gamePk)!;
    compared++;
    if (p.winProbability === prod.winProbability && p.predictedWinner === prod.predictedWinner) matched++;
    if (prod.inputSha256 !== undefined) inputMatched = (inputMatched ?? 0) + (prod.inputSha256 === slateSha ? 1 : 0);
    // A replay is not a prediction made at the time: no predictedAt, ever.
    delete p.predictedAt;
    p.flags = [...p.flags, "[info] replay"];
    predictions.push(p);
  }
  const sealedAt = opts.now.toISOString();
  return {
    source: "replay",
    league: opts.league,
    date: ct.date,
    replayedAt: sealedAt,
    codeVersion: opts.codeVersion,
    replayOf: { lockedAt: lock.lockedAt, updatedAt: lock.updatedAt ?? null, predictions: lock.predictions.length },
    input: { slateFetchedAt: bundle.fetchedAt ?? null, slateSha256: slateSha },
    calibration,
    calibrationAsOf: calibrationAsOfCheck(calibration, opts.history, ct.date),
    engine: { sims, passThreshold: cfg.passThreshold, minEv: cfg.minEv, simParams },
    reproduction: { matched, compared, inputMatched },
    predictionsSha256: sha256(JSON.stringify(predictions)),
    sealedAt,
    predictions,
  };
}
