import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateHistory } from "../src/engine/report";
import type { SettlementReport } from "../src/engine/settle";

const CAL = { shrink: 0.85, gamesSettled: 0, brierSum: 0, updatedAt: null };

function report(
  date: string,
  wins: number,
  losses: number,
  brier: number,
  stated: number,
): SettlementReport {
  const settled = wins + losses;
  return {
    date,
    gamesSettled: settled,
    gamesPassed: 1,
    gamesMissingResults: 0,
    winnerRecord: { wins, losses },
    handicapRecord: { wins: 1, losses: 0 },
    totalRecord: { wins: 0, losses: 1 },
    meanBrier: brier,
    statedVsActual: { statedMean: stated, actualRate: wins / settled },
    meanMarginError: 2,
    meanTotalError: 3,
    games: Array.from({ length: settled }, (_, i) => ({
      gamePk: i,
      home: "H",
      away: "A",
      pass: false,
      predictedWinner: "H",
      actualWinner: i < wins ? "H" : "A",
      winnerCorrect: i < wins,
      statedProbability: stated,
      brier,
      handicapPick: null,
      handicapCorrect: null,
      totalPick: null,
      totalCorrect: null,
      marginError: 2,
      totalError: 3,
    })),
    calibrationBefore: CAL,
    calibrationAfter: CAL,
  };
}

test("aggregateHistory sums records and weights Brier by games", () => {
  const s = aggregateHistory([
    report("2024-07-25", 2, 0, 0.2, 0.6),
    report("2024-07-26", 1, 1, 0.3, 0.58),
  ]);
  assert.equal(s.dates, 2);
  assert.equal(s.gamesSettled, 4);
  assert.deepEqual(s.winnerRecord, { wins: 3, losses: 1 });
  assert.equal(s.winnerRate, 0.75);
  // Games-weighted Brier: (0.2*2 + 0.3*2) / 4 = 0.25
  assert.equal(s.meanBrier, 0.25);
  // Pooled stated: (0.6*2 + 0.58*2)/4 = 0.59; actual 3/4.
  assert.equal(s.statedMean, 0.59);
  assert.equal(s.actualRate, 0.75);
  assert.equal(s.perDate.length, 2);
  assert.equal(s.perDate[0]!.date, "2024-07-25");
});

test("re-settled dates count once — the last report wins", () => {
  const s = aggregateHistory([
    report("2024-07-25", 0, 2, 0.6, 0.6), // early partial settle
    report("2024-07-25", 2, 0, 0.1, 0.6), // corrected re-settle
  ]);
  assert.equal(s.dates, 1);
  assert.equal(s.gamesSettled, 2);
  assert.deepEqual(s.winnerRecord, { wins: 2, losses: 0 });
  assert.equal(s.meanBrier, 0.1);
});

test("empty history yields nulls, not NaN", () => {
  const s = aggregateHistory([]);
  assert.equal(s.gamesSettled, 0);
  assert.equal(s.winnerRate, null);
  assert.equal(s.meanBrier, null);
  assert.equal(s.statedMean, null);
});
