import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateHistory,
  assessProfit,
  assessRecord,
  wilson95,
} from "../src/engine/report";
import type { SettledGame, SettlementReport } from "../src/engine/settle";

const CAL = {
  shrink: 0.85,
  tailShrink: 0.7,
  handicapShrink: 0.85,
  handicapTailShrink: 0.7,
  totalShrink: 0.85,
  totalTailShrink: 0.7,
  gamesSettled: 0,
  brierSum: 0,
  updatedAt: null,
};

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
      handicapProbability: null,
      totalPick: null,
      totalCorrect: null,
      totalProbability: null,
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
  assert.equal(s.handicapProfitTotal, null);
  assert.equal(s.handicapAssessment, null);
  assert.deepEqual(s.handicapBuckets, []);
  assert.deepEqual(s.byConfidence, []);
});

/** A fully-specified settled game for the decomposition views. */
function settledGame(over: Partial<SettledGame>): SettledGame {
  return {
    gamePk: 1,
    home: "H",
    away: "A",
    pass: false,
    confidence: "B",
    predictedWinner: "H",
    actualWinner: "H",
    winnerCorrect: true,
    statedProbability: 0.6,
    brier: 0.16,
    handicapPick: "H -〈0〉",
    handicapCorrect: true,
    handicapProfit: 0.9,
    handicapProbability: 0.6,
    totalPick: null,
    totalCorrect: null,
    totalProbability: null,
    marginError: 1,
    totalError: 1,
    ...over,
  };
}

function reportWith(date: string, games: SettledGame[]): SettlementReport {
  const scored = games.filter((g) => g.winnerCorrect !== null);
  const wins = scored.filter((g) => g.winnerCorrect).length;
  return {
    date,
    gamesSettled: scored.length,
    gamesPassed: 0,
    gamesMissingResults: 0,
    winnerRecord: { wins, losses: scored.length - wins },
    handicapRecord: {
      wins: games.filter((g) => g.handicapCorrect === true).length,
      losses: games.filter((g) => g.handicapCorrect === false).length,
    },
    handicapProfit: null,
    totalRecord: { wins: 0, losses: 0 },
    meanBrier: null,
    statedVsActual: null,
    meanMarginError: null,
    meanTotalError: null,
    games,
    calibrationBefore: CAL,
    calibrationAfter: CAL,
  };
}

test("the calibration curve decomposes by stated band", () => {
  // 55–60% band: said 0.57, hit 100%. 65–70% band: said 0.67, hit 0%.
  // Pooled they average out — the buckets must NOT.
  const games = [
    ...Array.from({ length: 4 }, (_, i) =>
      settledGame({
        gamePk: i,
        handicapProbability: 0.57,
        handicapCorrect: true,
      }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      settledGame({
        gamePk: 10 + i,
        handicapProbability: 0.67,
        handicapCorrect: false,
      }),
    ),
  ];
  const s = aggregateHistory([reportWith("2024-07-25", games)]);
  const low = s.handicapBuckets.find((b) => b.lo === 0.55)!;
  const high = s.handicapBuckets.find((b) => b.lo === 0.65)!;
  assert.equal(low.n, 4);
  assert.equal(low.actualRate, 1);
  assert.ok(low.gap > 0.4);
  assert.equal(high.n, 4);
  assert.equal(high.actualRate, 0);
  assert.ok(high.gap < -0.6);
});

test("records split by confidence, with handicap P&L attached", () => {
  const games = [
    settledGame({ gamePk: 1, confidence: "S", winnerCorrect: false, handicapProfit: -1 }),
    settledGame({ gamePk: 2, confidence: "B", winnerCorrect: true, handicapProfit: 0.9 }),
    settledGame({ gamePk: 3, confidence: "B", winnerCorrect: true, handicapProfit: 0.9 }),
    // History from before the field existed must be skipped, not miscounted.
    settledGame({ gamePk: 4, confidence: undefined, winnerCorrect: true }),
  ];
  const s = aggregateHistory([reportWith("2024-07-25", games)]);
  assert.deepEqual(
    s.byConfidence.map((c) => c.confidence),
    ["S", "B"],
  );
  const sBand = s.byConfidence.find((c) => c.confidence === "S")!;
  const bBand = s.byConfidence.find((c) => c.confidence === "B")!;
  assert.deepEqual(
    { n: sBand.n, wins: sBand.wins, profit: sBand.profit },
    { n: 1, wins: 0, profit: -1 },
  );
  assert.deepEqual(
    { n: bBand.n, wins: bBand.wins, profit: bBand.profit },
    { n: 2, wins: 2, profit: 1.8 },
  );
  // The book's bottom line sums every settled handicap stake.
  assert.equal(s.handicapProfitTotal, 1.7);
});

test("the significance assessment separates profit from proof", () => {
  // 7 of 10 is a fine-looking 70% that proves nothing: the 95% interval
  // still straddles the 52.6% break-even.
  const small = assessRecord(7, 3)!;
  assert.equal(small.significant, false);
  assert.equal(small.verdict, "inconclusive");
  assert.ok(small.ci95.lo < small.breakEven);
  // 70 of 100 is the same rate with enough sample to mean something.
  const big = assessRecord(70, 30)!;
  assert.equal(big.significant, true);
  assert.equal(big.verdict, "ahead");
  assert.ok(big.ci95.lo > big.breakEven);
  // A decisively LOSING record must say so — never "inconclusive".
  const losing = assessRecord(30, 70)!;
  assert.equal(losing.verdict, "behind");
  assert.equal(losing.significant, false);
  assert.equal(assessRecord(0, 0), null);
});

test("profit significance survives stake structures the win-rate test cannot", () => {
  // 60 "wins" that pay only +0.2 (partial 半-line stakes) against 40 full
  // losses: the RECORD looks ahead of break-even, the MONEY is deeply
  // negative. The profit test must call it behind.
  const partialBook = [
    ...Array.from({ length: 60 }, () => 0.2),
    ...Array.from({ length: 40 }, () => -1),
  ];
  const p = assessProfit(partialBook)!;
  assert.ok(p.meanProfit < 0);
  assert.equal(p.verdict, "behind");
  // The same shape with full 0.9 payouts is honestly ahead.
  const fullBook = [
    ...Array.from({ length: 70 }, () => 0.9),
    ...Array.from({ length: 30 }, () => -1),
  ];
  assert.equal(assessProfit(fullBook)!.verdict, "ahead");
  // Fewer than two stakes has no variance estimate.
  assert.equal(assessProfit([0.9]), null);
  assert.equal(assessProfit([]), null);
});

test("a tied final keeps its handicap loss in the confidence rows", () => {
  // Tie: winner market pushes (no W/L), but the handicap stake still lost.
  // The row's record must not count it; the row's MONEY must.
  const games = [
    settledGame({ gamePk: 1, confidence: "B", winnerCorrect: true, handicapProfit: 0.9 }),
    settledGame({
      gamePk: 2,
      confidence: "B",
      actualWinner: null,
      winnerCorrect: null,
      statedProbability: null,
      brier: null,
      handicapCorrect: false,
      handicapProfit: -1,
    }),
  ];
  const s = aggregateHistory([reportWith("2024-07-25", games)]);
  const b = s.byConfidence.find((c) => c.confidence === "B")!;
  assert.deepEqual(
    { n: b.n, wins: b.wins, profit: b.profit },
    { n: 1, wins: 1, profit: -0.1 },
  );
  // ...and the rows reconcile with the headline total.
  assert.equal(s.handicapProfitTotal, -0.1);
});

test("band flags are decided once, in the bucket itself", () => {
  const games = [
    ...Array.from({ length: 12 }, (_, i) =>
      settledGame({
        gamePk: i,
        handicapProbability: 0.67,
        handicapCorrect: false,
      }),
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      settledGame({
        gamePk: 100 + i,
        handicapProbability: 0.57,
        handicapCorrect: true,
      }),
    ),
  ];
  const s = aggregateHistory([reportWith("2024-07-25", games)]);
  assert.equal(
    s.handicapBuckets.find((b) => b.lo === 0.65)!.flag,
    "overconfident",
  );
  assert.equal(
    s.handicapBuckets.find((b) => b.lo === 0.55)!.flag,
    "underconfident",
  );
});

test("wilson95 behaves at the edges the naive interval gets wrong", () => {
  // n=0 → the whole [0,1], never NaN.
  assert.deepEqual(wilson95(0, 0), { lo: 0, hi: 1 });
  // A perfect 5/5 must NOT claim certainty.
  const perfect = wilson95(5, 5);
  assert.ok(perfect.hi === 1 && perfect.lo < 0.7);
  // Interval tightens with sample size at the same rate.
  const w10 = wilson95(6, 10);
  const w1000 = wilson95(600, 1000);
  assert.ok(w1000.hi - w1000.lo < w10.hi - w10.lo);
});
