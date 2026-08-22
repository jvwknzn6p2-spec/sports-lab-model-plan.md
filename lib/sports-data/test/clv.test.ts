/**
 * Closing-line value at settlement.
 *
 * The policy under test: CLV is stated ONLY like-for-like — the locked market
 * probability and the closing one must price the same point, oriented to the
 * picked side. A moved line, a missing snapshot, or a lock that never carried
 * a market probability states no number at all rather than a wrong one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { settle, type ClosingLine } from "../src/engine/settle";
import {
  DEFAULT_CALIBRATION,
  type GamePrediction,
} from "../src/engine/decision";

const NOW = new Date("2024-07-26T12:00:00Z");

function pred(opts: {
  pick: string;
  marketProbability?: number | null;
  totalMarket?: number | null;
}): GamePrediction {
  return {
    gamePk: 1,
    gameDate: null,
    home: "Guardians",
    away: "Tigers",
    pass: false,
    predictedWinner: "Guardians",
    predictedLoser: "Tigers",
    winProbability: 0.58,
    rawWinProbability: 0.6,
    confidence: "B",
    handicap: {
      input: { side: "home", line: -1.5, total: 8.5 },
      pick: opts.pick,
      coverProbability: 0.55,
      rawCoverProbability: 0.56,
      ev: 0.05,
      marketProbability: opts.marketProbability ?? null,
      noValue: false,
    },
    total: {
      line: 8.5,
      predicted: 8,
      pick: "OVER",
      probability: 0.54,
      rawProbability: 0.55,
      marketProbability: opts.totalMarket ?? null,
    },
    expectedRuns: { home: 4.6, away: 4.1 },
    reasons: [],
    flags: [],
  };
}

const RESULT = { "1": { homeScore: 6, awayScore: 3 } };

const closing = (l: Partial<ClosingLine>): Record<string, ClosingLine> => ({
  "1": {
    homeLine: null,
    homeCoverProb: null,
    total: null,
    overProb: null,
    ...l,
  },
});

test("CLV is the closing minus locked probability of the picked side, same point", () => {
  const report = settle(
    "2024-07-25",
    [pred({ pick: "Guardians -1.5", marketProbability: 0.52, totalMarket: 0.5 })],
    RESULT,
    DEFAULT_CALIBRATION,
    NOW,
    closing({ homeLine: -1.5, homeCoverProb: 0.56, total: 8.5, overProb: 0.53 }),
  );
  const g = report.games[0]!;
  assert.equal(g.handicapClv, 0.04);
  assert.equal(g.handicapLineMoved, false);
  assert.equal(g.totalClv, 0.03);
  assert.equal(g.totalLineMoved, false);
  assert.equal(report.meanHandicapClv, 0.04);
  assert.equal(report.handicapClvCount, 1);
  assert.equal(report.meanTotalClv, 0.03);
});

test("a pick on the away side flips the closing probability before comparing", () => {
  // Picked Tigers +1.5: locked market probability is already picked-side
  // (0.5); the closing home-cover 0.55 says the away side closed at 0.45.
  const report = settle(
    "2024-07-25",
    [pred({ pick: "Tigers +1.5", marketProbability: 0.5 })],
    RESULT,
    DEFAULT_CALIBRATION,
    NOW,
    closing({ homeLine: -1.5, homeCoverProb: 0.55 }),
  );
  assert.equal(report.games[0]!.handicapClv, -0.05);
});

test("a moved closing line states no CLV — a different point is a different bet", () => {
  const report = settle(
    "2024-07-25",
    [pred({ pick: "Guardians -1.5", marketProbability: 0.52 })],
    RESULT,
    DEFAULT_CALIBRATION,
    NOW,
    closing({ homeLine: -2, homeCoverProb: 0.5 }),
  );
  const g = report.games[0]!;
  assert.equal(g.handicapClv, null);
  assert.equal(g.handicapLineMoved, true);
  assert.equal(report.meanHandicapClv, null);
  assert.equal(report.handicapClvCount, 0);
});

test("no snapshot, or no locked market probability, states nothing", () => {
  // No snapshot at all.
  const without = settle(
    "2024-07-25",
    [pred({ pick: "Guardians -1.5", marketProbability: 0.52 })],
    RESULT,
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(without.games[0]!.handicapClv, null);
  assert.equal(without.games[0]!.handicapLineMoved, null);

  // Snapshot present, but the lock never carried a market probability (a
  // hand-entered or 半-notation line): nothing to compare against.
  const noLock = settle(
    "2024-07-25",
    [pred({ pick: "Guardians -1.5" })],
    RESULT,
    DEFAULT_CALIBRATION,
    NOW,
    closing({ homeLine: -1.5, homeCoverProb: 0.56 }),
  );
  assert.equal(noLock.games[0]!.handicapClv, null);
  assert.equal(noLock.games[0]!.handicapLineMoved, null);
});
