import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CALIBRATION,
  normalizeCalibration,
  type CalibrationState,
} from "../src/engine/decision";
import {
  recalibrateFromHistory,
  updateCalibration,
  type SettledGame,
  type SettlementReport,
} from "../src/engine/settle";

const NOW = new Date("2024-07-26T12:00:00Z");

function game(over: {
  winner?: { stated: number; correct: boolean };
  handicap?: { stated: number; correct: boolean };
  total?: { stated: number; correct: boolean };
}): SettledGame {
  return {
    gamePk: 1,
    home: "H",
    away: "A",
    pass: false,
    predictedWinner: "H",
    actualWinner: over.winner?.correct ? "H" : "A",
    winnerCorrect: over.winner?.correct ?? null,
    statedProbability: over.winner?.stated ?? null,
    brier: over.winner
      ? (over.winner.stated - (over.winner.correct ? 1 : 0)) ** 2
      : null,
    handicapPick: over.handicap ? "H -1.5" : null,
    handicapCorrect: over.handicap?.correct ?? null,
    handicapProbability: over.handicap?.stated ?? null,
    totalPick: over.total ? "OVER" : null,
    totalCorrect: over.total?.correct ?? null,
    totalProbability: over.total?.stated ?? null,
    marginError: 1,
    totalError: 1,
  };
}

function reportOf(date: string, games: SettledGame[]): SettlementReport {
  return {
    date,
    gamesSettled: games.filter((g) => g.winnerCorrect !== null).length,
    gamesPassed: 0,
    gamesMissingResults: 0,
    winnerRecord: { wins: 0, losses: 0 },
    handicapRecord: { wins: 0, losses: 0 },
    totalRecord: { wins: 0, losses: 0 },
    meanBrier: null,
    statedVsActual: null,
    meanMarginError: null,
    meanTotalError: null,
    games,
    calibrationBefore: DEFAULT_CALIBRATION,
    calibrationAfter: DEFAULT_CALIBRATION,
  };
}

test("each market learns from its own bets only", () => {
  // Winner picks all wrong (overconfident) while handicap picks all right
  // (underconfident). The two shrinks must move in OPPOSITE directions.
  const games = Array.from({ length: 10 }, () =>
    game({
      winner: { stated: 0.62, correct: false },
      handicap: { stated: 0.58, correct: true },
    }),
  );
  const s = updateCalibration(DEFAULT_CALIBRATION, games, NOW);
  assert.ok(
    s.shrink < DEFAULT_CALIBRATION.shrink,
    `winner shrink should fall, got ${s.shrink}`,
  );
  assert.ok(
    s.handicapShrink > DEFAULT_CALIBRATION.handicapShrink,
    `handicap shrink should rise, got ${s.handicapShrink}`,
  );
  // No total bets were scored, so that market must be untouched.
  assert.equal(s.totalShrink, DEFAULT_CALIBRATION.totalShrink);
});

test("the total market learns independently too", () => {
  const games = Array.from({ length: 10 }, () =>
    game({ total: { stated: 0.65, correct: false } }),
  );
  const s = updateCalibration(DEFAULT_CALIBRATION, games, NOW);
  assert.ok(s.totalShrink < DEFAULT_CALIBRATION.totalShrink);
  assert.equal(s.shrink, DEFAULT_CALIBRATION.shrink);
  assert.equal(s.handicapShrink, DEFAULT_CALIBRATION.handicapShrink);
});

test("settling the same date twice does not learn from it twice", () => {
  const games = Array.from({ length: 8 }, () =>
    game({ winner: { stated: 0.62, correct: false } }),
  );
  const once = recalibrateFromHistory(
    [reportOf("2024-07-25", games)],
    DEFAULT_CALIBRATION,
    NOW,
  );
  // The 16:00 pass re-settles the same date: history holds one report per
  // date, so the folded state must be identical, not doubly-shrunk.
  const twice = recalibrateFromHistory(
    [reportOf("2024-07-25", games), reportOf("2024-07-25", games)],
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(twice.shrink, once.shrink);
  assert.equal(twice.gamesSettled, once.gamesSettled);
  assert.equal(twice.gamesSettled, 8);
});

test("a corrected re-settle replaces the earlier result, not compounds it", () => {
  // Early pass saw only 2 games (both lost); the later pass has the full 8
  // (all won). Folding history must reflect ONLY the corrected report.
  const partial = reportOf("2024-07-25", [
    game({ winner: { stated: 0.6, correct: false } }),
    game({ winner: { stated: 0.6, correct: false } }),
  ]);
  const full = reportOf(
    "2024-07-25",
    Array.from({ length: 8 }, () =>
      game({ winner: { stated: 0.6, correct: true } }),
    ),
  );
  // Callers keep one report per date; the last one wins.
  const state = recalibrateFromHistory(
    [partial, full],
    DEFAULT_CALIBRATION,
    NOW,
  );
  const fullOnly = recalibrateFromHistory([full], DEFAULT_CALIBRATION, NOW);
  assert.deepEqual(state, fullOnly);
  assert.ok(state.shrink > DEFAULT_CALIBRATION.shrink, "all-correct → raise");
});

test("multi-day history folds oldest-first and accumulates", () => {
  const day = (d: string, correct: boolean) =>
    reportOf(
      d,
      Array.from({ length: 5 }, () =>
        game({ winner: { stated: 0.6, correct } }),
      ),
    );
  const s = recalibrateFromHistory(
    [day("2024-07-26", true), day("2024-07-25", false)],
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(s.gamesSettled, 10);
  assert.equal(s.updatedAt, NOW.toISOString());
});

test("an older single-shrink calibration.json upgrades without losing state", () => {
  const legacy = {
    shrink: 0.7,
    gamesSettled: 42,
    brierSum: 9.9,
    updatedAt: "x",
  };
  const s: CalibrationState = normalizeCalibration(legacy);
  assert.equal(s.shrink, 0.7);
  // Unseen markets inherit the learned value rather than resetting to default.
  assert.equal(s.handicapShrink, 0.7);
  assert.equal(s.totalShrink, 0.7);
  assert.equal(s.gamesSettled, 42);
  assert.deepEqual(normalizeCalibration({}), DEFAULT_CALIBRATION);
});
