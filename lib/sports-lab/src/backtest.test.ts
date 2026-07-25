import { test } from "node:test";
import assert from "node:assert/strict";
import {
  betProfit,
  explainBacktest,
  runBacktest,
  settleBet,
  toPredictionRecord,
  type PredictionRecord,
} from "./backtest";
import { americanToDecimal } from "./odds/conversion";
import { createRng } from "./model/random";
import type { BetEvaluation, BetMarket, BetSelection } from "./odds/ev";
import type { ConfidenceRank, FinalScore } from "./schemas";

/** A minimal bet, with only the fields settlement and scoring actually read. */
function bet(
  market: BetMarket,
  selection: BetSelection,
  line: number | null,
  americanOdds = -110,
  modelProbability = 0.55,
): BetEvaluation {
  const decimalOdds = americanToDecimal(americanOdds);
  return {
    market,
    selection,
    label: `${market}:${selection}:${line ?? "-"}`,
    line,
    americanOdds,
    decimalOdds,
    modelProbability,
    pushProbability: 0,
    modelProbabilityNoPush: modelProbability,
    impliedProbabilityRaw: 1 / decimalOdds,
    marketProbability: 0.5,
    edge: modelProbability - 0.5,
    ev: 0,
    evPercent: 0,
    isValueBet: true,
  };
}

function score(gameId: string, homeRuns: number, awayRuns: number): FinalScore {
  return { gameId, homeRuns, awayRuns };
}

function prediction(
  gameId: string,
  rank: ConfidenceRank,
  bets: BetEvaluation[],
  recommended = bets,
): PredictionRecord {
  return { gameId, rank, bets, recommended, homeWinProbability: 0.55 };
}

/* --- settlement ----------------------------------------------------------- */

test("moneyline settles on who won", () => {
  const s = score("g", 5, 3);
  assert.equal(settleBet(bet("moneyline", "home", null), s), "win");
  assert.equal(settleBet(bet("moneyline", "away", null), s), "loss");
});

test("run line settles on the margin against the spread", () => {
  const blowout = score("g", 6, 3); // margin 3
  assert.equal(settleBet(bet("run_line", "home", 1.5), blowout), "win");
  assert.equal(settleBet(bet("run_line", "away", 1.5), blowout), "loss");

  const narrow = score("g", 4, 3); // margin 1
  assert.equal(settleBet(bet("run_line", "home", 1.5), narrow), "loss");
  assert.equal(settleBet(bet("run_line", "away", 1.5), narrow), "win");
});

test("a whole-number run line pushes when the margin lands on it", () => {
  const s = score("g", 4, 3); // margin exactly 1
  assert.equal(settleBet(bet("run_line", "home", 1), s), "push");
  assert.equal(settleBet(bet("run_line", "away", 1), s), "push");
});

test("totals settle on the combined score", () => {
  const s = score("g", 5, 4); // total 9
  assert.equal(settleBet(bet("total", "over", 8.5), s), "win");
  assert.equal(settleBet(bet("total", "under", 8.5), s), "loss");
  assert.equal(settleBet(bet("total", "over", 9.5), s), "loss");
  assert.equal(settleBet(bet("total", "under", 9.5), s), "win");
});

test("a whole-number total pushes when the score lands on it", () => {
  const s = score("g", 5, 4); // total 9
  assert.equal(settleBet(bet("total", "over", 9), s), "push");
  assert.equal(settleBet(bet("total", "under", 9), s), "push");
});

test("a line-bearing bet logged without a line is refused", () => {
  assert.throws(() => settleBet(bet("run_line", "home", null), score("g", 5, 3)), RangeError);
  assert.throws(() => settleBet(bet("total", "over", null), score("g", 5, 3)), RangeError);
});

test("profit reflects the odds actually taken", () => {
  const plus = bet("moneyline", "home", null, 150);
  assert.ok(Math.abs(betProfit(plus, "win") - 1.5) < 1e-9);
  assert.equal(betProfit(plus, "loss"), -1);
  assert.equal(betProfit(plus, "push"), 0);

  const minus = bet("moneyline", "home", null, -200);
  assert.ok(Math.abs(betProfit(minus, "win") - 0.5) < 1e-9);
});

/* --- aggregation ---------------------------------------------------------- */

test("a perfect record shows a positive ROI", () => {
  const entries = [1, 2, 3].map((i) => ({
    prediction: prediction(`g${i}`, "S", [bet("moneyline", "home", null)]),
    score: score(`g${i}`, 5, 2),
  }));
  const r = runBacktest(entries, { minSample: 1 });
  assert.equal(r.overall.wins, 3);
  assert.equal(r.overall.losses, 0);
  assert.equal(r.overall.hitRate, 1);
  assert.ok(r.overall.roi! > 0);
});

test("pushes are excluded from accuracy but still stake a unit", () => {
  const entries = [
    { prediction: prediction("g1", "A", [bet("total", "over", 9)]), score: score("g1", 5, 4) },
    { prediction: prediction("g2", "A", [bet("total", "over", 9)]), score: score("g2", 6, 4) },
  ];
  const r = runBacktest(entries, { minSample: 1 });
  assert.equal(r.overall.pushes, 1);
  assert.equal(r.overall.resolved, 1);
  assert.equal(r.overall.hitRate, 1, "the push must not count against accuracy");
  assert.equal(r.overall.unitsStaked, 2, "but it was still a placed bet");
});

test("rates are null rather than a fake zero when nothing resolved", () => {
  const r = runBacktest([], { minSample: 1 });
  assert.equal(r.overall.hitRate, null);
  assert.equal(r.overall.roi, null);
  assert.equal(r.brierScore, null);
  assert.equal(r.games, 0);
});

test("only recommended bets count toward the recommended summary", () => {
  const good = bet("moneyline", "home", null);
  const ignored = bet("moneyline", "away", null);
  const entries = [
    {
      prediction: prediction("g1", "S", [good, ignored], [good]),
      score: score("g1", 5, 2),
    },
  ];
  const r = runBacktest(entries, { minSample: 1 });
  assert.equal(r.overall.bets, 2);
  assert.equal(r.recommended.bets, 1);
  assert.equal(r.recommended.wins, 1);
});

test("results are broken down by rank and by market", () => {
  const entries = [
    { prediction: prediction("g1", "S", [bet("moneyline", "home", null)]), score: score("g1", 5, 2) },
    { prediction: prediction("g2", "B", [bet("total", "over", 8.5)]), score: score("g2", 2, 1) },
  ];
  const r = runBacktest(entries, { minSample: 1 });
  assert.equal(r.byRank.S.wins, 1);
  assert.equal(r.byRank.B.losses, 1);
  assert.equal(r.byMarket.moneyline.bets, 1);
  assert.equal(r.byMarket.total.bets, 1);
  assert.equal(r.byMarket.run_line.bets, 0);
});

test("scoring a prediction against the wrong game is refused", () => {
  assert.throws(
    () =>
      runBacktest([
        { prediction: prediction("g1", "S", [bet("moneyline", "home", null)]), score: score("g2", 5, 2) },
      ]),
    /Result mismatch/,
  );
});

/* --- honesty about small samples ------------------------------------------ */

test("a small sample is marked insufficient", () => {
  const entries = [
    { prediction: prediction("g1", "S", [bet("moneyline", "home", null)]), score: score("g1", 5, 2) },
  ];
  const r = runBacktest(entries, { minSample: 30 });
  assert.equal(r.overall.sufficientSample, false);
  assert.equal(r.rankOrderingHolds, null, "one rank cannot establish an ordering");
});

test("rank ordering is only judged once ranks have enough data", () => {
  // S wins every bet, B loses every bet — a clean ordering.
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => ({
      prediction: prediction(`s${i}`, "S" as const, [bet("moneyline", "home", null)]),
      score: score(`s${i}`, 5, 2),
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      prediction: prediction(`b${i}`, "B" as const, [bet("moneyline", "home", null)]),
      score: score(`b${i}`, 2, 5),
    })),
  ];
  const r = runBacktest(entries, { minSample: 5 });
  assert.equal(r.rankOrderingHolds, true);
  assert.ok(r.byRank.S.roi! > r.byRank.B.roi!);
});

test("a broken rank ordering is reported as broken", () => {
  // S loses everything, B wins everything — exactly backwards.
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => ({
      prediction: prediction(`s${i}`, "S" as const, [bet("moneyline", "home", null)]),
      score: score(`s${i}`, 2, 5),
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      prediction: prediction(`b${i}`, "B" as const, [bet("moneyline", "home", null)]),
      score: score(`b${i}`, 5, 2),
    })),
  ];
  const r = runBacktest(entries, { minSample: 5 });
  assert.equal(r.rankOrderingHolds, false);
});

/* --- calibration ---------------------------------------------------------- */

test("a well-calibrated model shows predicted matching actual", () => {
  // Synthetic truth: bets claimed at 70% really do win 70% of the time.
  const rng = createRng(7);
  const entries = Array.from({ length: 600 }, (_, i) => {
    const won = rng() < 0.7;
    return {
      prediction: prediction(`g${i}`, "A" as const, [
        bet("moneyline", "home", null, -110, 0.7),
      ]),
      score: won ? score(`g${i}`, 5, 2) : score(`g${i}`, 2, 5),
    };
  });
  const r = runBacktest(entries, { minSample: 30 });

  const bin = r.calibration.find((b) => b.lower === 0.7)!;
  assert.ok(bin.count > 500);
  assert.ok(Math.abs(bin.predicted! - 0.7) < 0.01);
  assert.ok(Math.abs(bin.actual! - 0.7) < 0.05, `actual was ${bin.actual}`);
});

test("calibration detects an overconfident model", () => {
  // The model claims 90% but the bets only win half the time.
  const rng = createRng(11);
  const entries = Array.from({ length: 400 }, (_, i) => {
    const won = rng() < 0.5;
    return {
      prediction: prediction(`g${i}`, "S" as const, [
        bet("moneyline", "home", null, -110, 0.9),
      ]),
      score: won ? score(`g${i}`, 5, 2) : score(`g${i}`, 2, 5),
    };
  });
  const r = runBacktest(entries, { minSample: 30 });

  const bin = r.calibration.find((b) => b.lower === 0.9)!;
  assert.ok(bin.predicted! - bin.actual! > 0.3, "the gap must be obvious");
  // A badly calibrated model scores worse than always guessing 50%.
  assert.ok(r.brierScore! > 0.25, `Brier was ${r.brierScore}`);
});

test("a confident and correct model beats the coin-flip Brier score", () => {
  const rng = createRng(13);
  const entries = Array.from({ length: 400 }, (_, i) => {
    const won = rng() < 0.9;
    return {
      prediction: prediction(`g${i}`, "S" as const, [
        bet("moneyline", "home", null, -110, 0.9),
      ]),
      score: won ? score(`g${i}`, 5, 2) : score(`g${i}`, 2, 5),
    };
  });
  const r = runBacktest(entries, { minSample: 30 });
  assert.ok(r.brierScore! < 0.15, `Brier was ${r.brierScore}`);
});

test("calibration bins cover the whole range and include certainty", () => {
  const entries = [
    {
      prediction: prediction("g1", "S", [bet("moneyline", "home", null, -110, 1)]),
      score: score("g1", 5, 2),
    },
  ];
  const r = runBacktest(entries, { minSample: 1 });
  assert.equal(r.calibration.length, 10);
  const last = r.calibration[9];
  assert.equal(last.count, 1, "a probability of exactly 1.0 must land in the top bin");
});

/* --- record building and reporting ---------------------------------------- */

test("toPredictionRecord captures what scoring later needs", () => {
  const good = bet("moneyline", "home", null);
  const record = toPredictionRecord(
    { gameId: "g1", rank: "A" } as never,
    { bets: [good], valueBets: [good] } as never,
    { moneyline: { home: 0.61, away: 0.39 } } as never,
  );
  assert.equal(record.gameId, "g1");
  assert.equal(record.rank, "A");
  assert.equal(record.homeWinProbability, 0.61);
  assert.equal(record.recommended.length, 1);
});

test("explainBacktest reports the headline numbers and the sample warning", () => {
  const entries = [
    { prediction: prediction("g1", "S", [bet("moneyline", "home", null)]), score: score("g1", 5, 2) },
  ];
  const lines = explainBacktest(runBacktest(entries, { minSample: 30 }));
  const text = lines.join("\n");
  assert.match(text, /Backtest over 1 games/);
  assert.match(text, /small sample/);
  assert.match(text, /not enough data to say/);
  assert.match(text, /Brier score/);
});

test("explainBacktest calls out a broken rank ordering loudly", () => {
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => ({
      prediction: prediction(`s${i}`, "S" as const, [bet("moneyline", "home", null)]),
      score: score(`s${i}`, 2, 5),
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      prediction: prediction(`b${i}`, "B" as const, [bet("moneyline", "home", null)]),
      score: score(`b${i}`, 5, 2),
    })),
  ];
  const text = explainBacktest(runBacktest(entries, { minSample: 5 })).join("\n");
  assert.match(text, /NO — thresholds need recalibration/);
});
