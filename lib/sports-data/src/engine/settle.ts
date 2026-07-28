/**
 * Settlement → error analysis → self-learning (post-game loop).
 *
 * Given a locked prediction file and final scores:
 *   - score every non-PASS pick (winner, handicap, total)
 *   - compute per-game and aggregate error metrics (Brier, margin/total error)
 *   - update the calibration state: if the model's stated probabilities were
 *     overconfident (actual win rate below stated), shrink future edges;
 *     if underconfident, expand them. Bounded, small steps (v1 self-learning).
 */

import type { CalibrationState, GamePrediction } from "./decision";

export interface GameResult {
  homeScore: number;
  awayScore: number;
}

export interface SettledGame {
  gamePk: number;
  home: string;
  away: string;
  pass: boolean;
  predictedWinner: string | null;
  actualWinner: string;
  winnerCorrect: boolean | null; // null for PASS
  statedProbability: number | null;
  brier: number | null;
  handicapPick: string | null;
  handicapCorrect: boolean | null;
  /** Stated probability that the handicap pick covers (for learning). */
  handicapProbability: number | null;
  totalPick: "OVER" | "UNDER" | null;
  totalCorrect: boolean | null;
  /** Stated probability for the total pick (for learning). */
  totalProbability: number | null;
  marginError: number | null; // |predicted margin − actual margin|
  totalError: number | null; // |predicted total − actual total|
}

export interface SettlementReport {
  date: string;
  gamesSettled: number;
  gamesPassed: number;
  gamesMissingResults: number;
  winnerRecord: { wins: number; losses: number };
  handicapRecord: { wins: number; losses: number };
  totalRecord: { wins: number; losses: number };
  meanBrier: number | null;
  statedVsActual: { statedMean: number; actualRate: number } | null;
  meanMarginError: number | null;
  meanTotalError: number | null;
  games: SettledGame[];
  calibrationBefore: CalibrationState;
  calibrationAfter: CalibrationState;
}

/** Learning-rate and bounds for the shrink update. */
const LEARN_RATE = 0.25;
const SHRINK_MIN = 0.5;
const SHRINK_MAX = 1.0;

/** One scored bet: what we said would happen, and whether it did. */
interface MarketSample {
  stated: number;
  correct: boolean;
}

/**
 * Move one market's shrink toward reality.
 *
 * Overconfident (we said 60%, we hit 50%) lowers the shrink so future edges
 * are quoted closer to 50%; underconfident raises it. Damped by sample size so
 * a single slate never swings the state, and clamped so it can never collapse
 * to "always 50%" or run away past "trust the raw model".
 */
function learnMarket(current: number, samples: MarketSample[]): number {
  if (samples.length === 0) return current;
  const statedMean =
    samples.reduce((acc, s) => acc + s.stated, 0) / samples.length;
  const actualRate = samples.filter((s) => s.correct).length / samples.length;
  const gap = actualRate - statedMean;
  const damping = samples.length / (samples.length + 20);
  return (
    Math.round(
      clamp(current + LEARN_RATE * gap * damping, SHRINK_MIN, SHRINK_MAX) *
        1000,
    ) / 1000
  );
}

/** Every market learns from its OWN scored bets, independently. */
export function updateCalibration(
  state: CalibrationState,
  settled: SettledGame[],
  now: Date,
): CalibrationState {
  const winner: MarketSample[] = [];
  const handicap: MarketSample[] = [];
  const total: MarketSample[] = [];
  let brierSum = 0;

  for (const s of settled) {
    if (s.winnerCorrect !== null && s.statedProbability !== null) {
      winner.push({ stated: s.statedProbability, correct: s.winnerCorrect });
      brierSum += s.brier ?? 0;
    }
    if (s.handicapCorrect !== null && s.handicapProbability !== null) {
      handicap.push({
        stated: s.handicapProbability,
        correct: s.handicapCorrect,
      });
    }
    if (s.totalCorrect !== null && s.totalProbability !== null) {
      total.push({ stated: s.totalProbability, correct: s.totalCorrect });
    }
  }

  if (winner.length === 0 && handicap.length === 0 && total.length === 0) {
    return state;
  }

  return {
    shrink: learnMarket(state.shrink, winner),
    handicapShrink: learnMarket(state.handicapShrink, handicap),
    totalShrink: learnMarket(state.totalShrink, total),
    gamesSettled: state.gamesSettled + winner.length,
    brierSum: Math.round((state.brierSum + brierSum) * 10000) / 10000,
    updatedAt: now.toISOString(),
  };
}

/**
 * Recompute the calibration state from the WHOLE settlement history.
 *
 * Settling is not a one-shot event: a slate gets settled once when the early
 * games finish and again later to pick up west-coast stragglers. Applying
 * `updateCalibration` incrementally on every run would learn from the same
 * games twice. Folding the full history instead — one report per date, oldest
 * first — makes settlement idempotent and lets a corrected re-settle actually
 * correct the learned state rather than compound it.
 */
export function recalibrateFromHistory(
  reports: SettlementReport[],
  base: CalibrationState,
  now: Date,
): CalibrationState {
  const byDate = new Map<string, SettlementReport>();
  for (const r of reports) byDate.set(r.date, r);
  const chronological = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  let state: CalibrationState = {
    ...base,
    gamesSettled: 0,
    brierSum: 0,
    updatedAt: null,
  };
  for (const r of chronological) {
    state = updateCalibration(state, r.games, now);
  }
  return state;
}

export function settle(
  date: string,
  predictions: GamePrediction[],
  results: Record<string, GameResult>,
  calibration: CalibrationState,
  now: Date,
): SettlementReport {
  const games: SettledGame[] = [];
  let missing = 0;

  for (const p of predictions) {
    const r = results[String(p.gamePk)];
    if (!r) {
      missing++;
      continue;
    }
    const actualWinner = r.homeScore > r.awayScore ? p.home : p.away;
    const actualMargin = r.homeScore - r.awayScore; // home perspective
    const actualTotal = r.homeScore + r.awayScore;
    const predictedMargin = p.expectedRuns.home - p.expectedRuns.away;

    let winnerCorrect: boolean | null = null;
    let brier: number | null = null;
    if (!p.pass && p.predictedWinner) {
      winnerCorrect = p.predictedWinner === actualWinner;
      const outcome = winnerCorrect ? 1 : 0;
      brier = (p.winProbability - outcome) ** 2;
    }

    let handicapCorrect: boolean | null = null;
    if (!p.pass && p.handicap.pick && p.handicap.input) {
      // The pick string names the covering side; recompute from the score.
      const line = p.handicap.input.line;
      const quotedSideMargin =
        p.handicap.input.side === "home" ? actualMargin : -actualMargin;
      const quotedCovered = quotedSideMargin + line > 0;
      const pickedQuotedSide = p.handicap.pick.startsWith(
        p.handicap.input.side === "home" ? p.home : p.away,
      );
      handicapCorrect = pickedQuotedSide ? quotedCovered : !quotedCovered;
    }

    let totalCorrect: boolean | null = null;
    if (
      !p.pass &&
      p.total.pick &&
      p.total.line !== null &&
      actualTotal !== p.total.line
    ) {
      totalCorrect =
        p.total.pick === "OVER"
          ? actualTotal > p.total.line
          : actualTotal < p.total.line;
    }

    games.push({
      gamePk: p.gamePk,
      home: p.home,
      away: p.away,
      pass: p.pass,
      predictedWinner: p.predictedWinner,
      actualWinner,
      winnerCorrect,
      statedProbability: p.pass ? null : p.winProbability,
      brier: brier === null ? null : Math.round(brier * 10000) / 10000,
      handicapPick: p.handicap.pick,
      handicapCorrect,
      handicapProbability: p.handicap.coverProbability,
      totalPick: p.total.pick,
      totalCorrect,
      totalProbability: p.total.probability,
      marginError: p.pass
        ? null
        : Math.round(Math.abs(predictedMargin - actualMargin) * 100) / 100,
      totalError: p.pass
        ? null
        : Math.round(Math.abs(p.total.predicted - actualTotal) * 100) / 100,
    });
  }

  const scored = games.filter((g) => g.winnerCorrect !== null);
  const record = (xs: (boolean | null)[]) => ({
    wins: xs.filter((x) => x === true).length,
    losses: xs.filter((x) => x === false).length,
  });

  const calibrationAfter = updateCalibration(calibration, games, now);

  return {
    date,
    gamesSettled: scored.length,
    gamesPassed: games.filter((g) => g.pass).length,
    gamesMissingResults: missing,
    winnerRecord: record(games.map((g) => g.winnerCorrect)),
    handicapRecord: record(games.map((g) => g.handicapCorrect)),
    totalRecord: record(games.map((g) => g.totalCorrect)),
    meanBrier: mean(scored.map((g) => g.brier ?? 0)),
    statedVsActual:
      scored.length === 0
        ? null
        : {
            statedMean: round3(
              mean(scored.map((g) => g.statedProbability ?? 0))!,
            ),
            actualRate: round3(
              scored.filter((g) => g.winnerCorrect).length / scored.length,
            ),
          },
    meanMarginError: mean(
      games.filter((g) => g.marginError !== null).map((g) => g.marginError!),
    ),
    meanTotalError: mean(
      games.filter((g) => g.totalError !== null).map((g) => g.totalError!),
    ),
    games,
    calibrationBefore: calibration,
    calibrationAfter,
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]): number | null =>
  xs.length === 0
    ? null
    : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
