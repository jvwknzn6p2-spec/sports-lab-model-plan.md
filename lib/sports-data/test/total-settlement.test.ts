/**
 * Total (over/under) settlement, end to end.
 *
 * The 2026-08-22 control tower is the first to carry market total lines, so
 * the first real total bets settle from it. This suite proves the whole path
 * in advance on the exact shapes the pipeline writes: win, loss, exact-line
 * push, record accounting, band stamps, and the totalShrink learning that
 * only these bets can move.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CALIBRATION,
  type GamePrediction,
} from "../src/engine/decision";
import { settle } from "../src/engine/settle";
import { marketRecordLabel, TOTAL_MARKET_NEVER_QUOTED } from "../src/engine/report";

const NOW = new Date("2026-08-23T04:00:00Z");

function prediction(over: {
  gamePk: number;
  totalLine: number;
  totalPick: "OVER" | "UNDER";
  totalProbability?: number;
  rawTotalProbability?: number;
}): GamePrediction {
  return {
    gamePk: over.gamePk,
    gameDate: "2026-08-22T23:10:00Z",
    home: "H",
    away: "A",
    pass: false,
    predictedWinner: "H",
    predictedLoser: "A",
    winProbability: 0.58,
    rawWinProbability: 0.593,
    confidence: "B",
    handicap: {
      input: null,
      pick: null,
      coverProbability: null,
      rawCoverProbability: null,
      ev: null,
      noValue: false,
    },
    total: {
      line: over.totalLine,
      predicted: 8.4,
      pick: over.totalPick,
      probability: over.totalProbability ?? 0.56,
      rawProbability: over.rawTotalProbability ?? 0.571,
    },
    expectedRuns: { home: 4.4, away: 4.0 },
    reasons: [],
    flags: [],
  };
}

test("total bets settle: win, loss, and exact-line push", () => {
  const preds = [
    prediction({ gamePk: 1, totalLine: 8.5, totalPick: "OVER" }), // 9 runs → win
    prediction({ gamePk: 2, totalLine: 7.5, totalPick: "UNDER" }), // 9 runs → loss
    prediction({ gamePk: 3, totalLine: 8, totalPick: "OVER" }), // exactly 8 → push
  ];
  const report = settle(
    "2026-08-22",
    preds,
    {
      "1": { homeScore: 5, awayScore: 4 },
      "2": { homeScore: 6, awayScore: 3 },
      "3": { homeScore: 5, awayScore: 3 },
    },
    DEFAULT_CALIBRATION,
    NOW,
  );

  assert.equal(report.totalRecord.wins, 1);
  assert.equal(report.totalRecord.losses, 1);
  const [win, loss, push] = report.games;
  assert.equal(win!.totalCorrect, true);
  assert.equal(loss!.totalCorrect, false);
  // A final landing exactly on the line pushes: the stake comes back, and a
  // push must neither count in the record nor teach the calibrator.
  assert.equal(push!.totalCorrect, null);
  assert.equal(push!.totalTail, null);

  // Band stamps come from the lock's own raw probability (0.571 → core).
  assert.equal(win!.totalTail, false);
  assert.equal(win!.totalFarTail, false);

  // Only the two decided bets reach the total market's learning; the mixed
  // 1-1 outcome against a stated 56% mean nudges totalShrink, and no other
  // market moves off total bets alone.
  assert.notEqual(
    report.calibrationAfter.totalShrink,
    DEFAULT_CALIBRATION.totalShrink,
  );
  assert.equal(report.calibrationAfter.handicapShrink, DEFAULT_CALIBRATION.handicapShrink);

  // The summary label switches off its "never quoted" explanation the moment
  // a real record exists.
  assert.equal(
    marketRecordLabel(report.totalRecord, TOTAL_MARKET_NEVER_QUOTED),
    "1-1",
  );
});

test("a raw far-tail total stamps its band and teaches the far tail only", () => {
  const preds = [
    prediction({
      gamePk: 1,
      totalLine: 8.5,
      totalPick: "OVER",
      totalProbability: 0.68,
      rawTotalProbability: 0.73,
    }),
  ];
  const report = settle(
    "2026-08-22",
    preds,
    { "1": { homeScore: 3, awayScore: 2 } }, // 5 runs → OVER 8.5 loses
    DEFAULT_CALIBRATION,
    NOW,
  );
  const g = report.games[0]!;
  assert.equal(g.totalCorrect, false);
  assert.equal(g.totalTail, true);
  assert.equal(g.totalFarTail, true);
  assert.ok(
    report.calibrationAfter.totalFarTailShrink <
      DEFAULT_CALIBRATION.totalFarTailShrink,
  );
  assert.equal(
    report.calibrationAfter.totalTailShrink,
    DEFAULT_CALIBRATION.totalTailShrink,
  );
});
