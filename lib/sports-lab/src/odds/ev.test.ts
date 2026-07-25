import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBaseline } from "../model/baseline";
import { simulateGame, type SimulationResult } from "../model/simulate";
import { neutralGame } from "../test-fixtures";
import { americanToDecimal } from "./conversion";
import { evaluateOdds, expectedValue, explainEvaluation } from "./ev";
import type { GameOdds } from "../schemas";

const LABELS = { home: "Astros", away: "Angels" };
const FETCHED = "2026-07-25T12:00:00Z";

function simFor(homeRpg?: number, awayRpg?: number, totalLine: number | null = 8.5) {
  const { game, context } = neutralGame();
  if (homeRpg !== undefined) game.homeBatting!.runsPerGame = homeRpg;
  if (awayRpg !== undefined) game.awayBatting!.runsPerGame = awayRpg;
  return simulateGame(computeBaseline(game, context), { iterations: 20_000, totalLine });
}

function oddsFor(overrides: Partial<GameOdds> = {}): GameOdds {
  return {
    gameId: "g-1",
    sportsbook: "TestBook",
    moneyline: { home: -110, away: -110 },
    runLine: { line: 1.5, homePrice: 130, awayPrice: -150 },
    total: { line: 8.5, overPrice: -110, underPrice: -110 },
    fetchedAt: FETCHED,
    ...overrides,
  };
}

/* --- the EV formula itself ------------------------------------------------ */

test("expectedValue matches the textbook formula", () => {
  // Even-money bet at a true 60%: EV = 0.6 × 1 − 0.4 = +0.20 per unit.
  assert.ok(Math.abs(expectedValue(2, 0.6, 0.4) - 0.2) < 1e-9);
  // A fair coin at even money is exactly break-even.
  assert.ok(Math.abs(expectedValue(2, 0.5, 0.5)) < 1e-9);
  // Paying -110 on a coin flip is the book's edge, not ours.
  assert.ok(expectedValue(americanToDecimal(-110), 0.5, 0.5) < 0);
});

test("a push contributes nothing to EV", () => {
  // 50% win / 30% lose / 20% push at even money.
  assert.ok(Math.abs(expectedValue(2, 0.5, 0.3) - 0.2) < 1e-9);
});

/* --- moneyline ------------------------------------------------------------ */

test("a model edge over the market produces a positive-EV flagged bet", () => {
  const sim = simFor(6.5, 3.5); // home much stronger than -110 implies
  const ev = evaluateOdds(sim, oddsFor(), LABELS);
  const homeMl = ev.bets.find((b) => b.market === "moneyline" && b.selection === "home")!;

  assert.ok(homeMl.modelProbability > 0.6, "model should love the home side");
  assert.ok(Math.abs(homeMl.marketProbability - 0.5) < 1e-9, "-110/-110 de-vigs to 50/50");
  assert.ok(homeMl.edge > 0.1);
  assert.ok(homeMl.ev > 0);
  assert.equal(homeMl.isValueBet, true);
});

test("the other side of the same market is negative EV", () => {
  const ev = evaluateOdds(simFor(6.5, 3.5), oddsFor(), LABELS);
  const awayMl = ev.bets.find((b) => b.market === "moneyline" && b.selection === "away")!;
  assert.ok(awayMl.edge < 0);
  assert.ok(awayMl.ev < 0);
  assert.equal(awayMl.isValueBet, false);
});

test("a market that agrees with the model yields no value bet", () => {
  const sim = simFor(); // near a coin flip
  // Price the market at the model's own probabilities, plus normal vig.
  const ev = evaluateOdds(sim, oddsFor(), LABELS);
  const homeMl = ev.bets.find((b) => b.market === "moneyline" && b.selection === "home")!;
  assert.ok(Math.abs(homeMl.edge) < 0.05, `edge was ${homeMl.edge}`);
  assert.equal(homeMl.isValueBet, false);
});

test("vig is removed before the comparison, never after", () => {
  const ev = evaluateOdds(simFor(), oddsFor(), LABELS);
  const homeMl = ev.bets.find((b) => b.market === "moneyline" && b.selection === "home")!;
  // Raw -110 implies 52.4%; the fair number must be lower.
  assert.ok(homeMl.impliedProbabilityRaw > 0.52);
  assert.ok(homeMl.marketProbability < homeMl.impliedProbabilityRaw);
  assert.ok(Math.abs(homeMl.marketProbability - 0.5) < 1e-9);
});

test("minEdge keeps marginal disagreements from being flagged", () => {
  const sim = simFor(4.8, 4.4); // a small genuine edge
  const loose = evaluateOdds(sim, oddsFor(), LABELS, { minEdge: 0 });
  const strict = evaluateOdds(sim, oddsFor(), LABELS, { minEdge: 0.25 });
  assert.ok(loose.valueBets.length > 0);
  assert.equal(strict.valueBets.length, 0);
});

/* --- totals and pushes ---------------------------------------------------- */

test("over and under are evaluated against the posted total", () => {
  const ev = evaluateOdds(simFor(), oddsFor(), LABELS);
  const over = ev.bets.find((b) => b.selection === "over")!;
  const under = ev.bets.find((b) => b.selection === "under")!;
  assert.equal(over.label, "OVER 8.5");
  assert.equal(under.label, "UNDER 8.5");
  assert.ok(Math.abs(over.modelProbability + under.modelProbability - 1) < 1e-9);
});

test("a whole-number total reports a push and uses it correctly", () => {
  const { game, context } = neutralGame();
  const sim = simulateGame(computeBaseline(game, context), {
    iterations: 20_000,
    totalLine: 9,
  });
  const ev = evaluateOdds(sim, oddsFor({ total: { line: 9, overPrice: -110, underPrice: -110 } }), LABELS);
  const over = ev.bets.find((b) => b.selection === "over")!;

  assert.ok(over.pushProbability > 0, "a 9.0 line should push sometimes");
  // The conditional probability must exceed the unconditional one, because
  // push mass is removed from the denominator.
  assert.ok(over.modelProbabilityNoPush > over.modelProbability);
  // Edge is computed against the conditional figure, matching the de-vigged market.
  assert.ok(Math.abs(over.edge - (over.modelProbabilityNoPush - over.marketProbability)) < 1e-9);
});

test("pushes make a bet strictly better than the same bet that loses instead", () => {
  const decimal = americanToDecimal(-110);
  const withPush = expectedValue(decimal, 0.45, 0.45); // 10% push
  const withoutPush = expectedValue(decimal, 0.45, 0.55);
  assert.ok(withPush > withoutPush);
});

/* --- run line ------------------------------------------------------------- */

test("run-line bets are priced off the matching simulated line", () => {
  const ev = evaluateOdds(simFor(5.6, 4.0), oddsFor(), LABELS);
  const homeRl = ev.bets.find((b) => b.market === "run_line" && b.selection === "home")!;
  const awayRl = ev.bets.find((b) => b.market === "run_line" && b.selection === "away")!;
  assert.equal(homeRl.label, "Astros -1.5");
  assert.equal(awayRl.label, "Angels +1.5");
  assert.ok(Math.abs(homeRl.modelProbability + awayRl.modelProbability - 1) < 1e-9);
});

test("a run line the simulation did not price is refused, not guessed", () => {
  const sim = simFor(); // simulated at the default 1.5
  assert.throws(
    () => evaluateOdds(sim, oddsFor({ runLine: { line: 2.5, homePrice: 130, awayPrice: -150 } }), LABELS),
    /Run-line mismatch/,
  );
});

test("a total the simulation did not price is refused, not guessed", () => {
  const sim = simFor(undefined, undefined, 8.5);
  assert.throws(
    () => evaluateOdds(sim, oddsFor({ total: { line: 10.5, overPrice: -110, underPrice: -110 } }), LABELS),
    /Total-line mismatch/,
  );
});

test("odds with a total but no simulated total line are refused", () => {
  const sim = simFor(undefined, undefined, null);
  assert.throws(() => evaluateOdds(sim, oddsFor(), LABELS), /without a totalLine/);
});

/* --- missing markets and reporting ---------------------------------------- */

test("markets the book has not posted are skipped, not treated as errors", () => {
  const sim = simFor(undefined, undefined, null);
  const ev = evaluateOdds(sim, oddsFor({ runLine: null, total: null }), LABELS);
  assert.deepEqual(ev.skippedMarkets, ["run_line", "total"]);
  assert.equal(ev.bets.length, 2); // moneyline only
});

test("a game with no posted markets yields no bets and no crash", () => {
  const sim = simFor(undefined, undefined, null);
  const ev = evaluateOdds(sim, oddsFor({ moneyline: null, runLine: null, total: null }), LABELS);
  assert.equal(ev.bets.length, 0);
  assert.equal(ev.valueBets.length, 0);
  assert.deepEqual(explainEvaluation(ev), ["Value:       no markets priced"]);
});

test("bets are sorted by EV, best first", () => {
  const ev = evaluateOdds(simFor(6.5, 3.5), oddsFor(), LABELS);
  for (let i = 1; i < ev.bets.length; i++) {
    assert.ok(ev.bets[i - 1].ev >= ev.bets[i].ev, "bets must be ranked by EV");
  }
  assert.ok(ev.valueBets.every((b) => b.isValueBet));
});

test("the evaluation records the book and the odds timestamp", () => {
  const ev = evaluateOdds(simFor(), oddsFor(), LABELS);
  assert.equal(ev.sportsbook, "TestBook");
  assert.equal(ev.oddsFetchedAt, FETCHED);
  assert.equal(ev.gameId, "g-1");
});

test("explainEvaluation marks value bets and shows rejected ones too", () => {
  const ev = evaluateOdds(simFor(6.5, 3.5), oddsFor(), LABELS);
  const lines = explainEvaluation(ev);
  assert.equal(lines.length, ev.bets.length);
  assert.match(lines[0], /^Value:/);
  assert.ok(lines.some((l) => l.includes("✅")), "a clear edge should be marked");
  assert.ok(lines.some((l) => l.includes("EV negative")), "rejected bets stay visible");
});

test("a simulation result flows into EV without reshaping", () => {
  const sim: SimulationResult = simFor(5.0, 4.4);
  const ev = evaluateOdds(sim, oddsFor(), LABELS);
  assert.equal(ev.gameId, sim.gameId);
  assert.equal(ev.bets.length, 6); // 2 per market × 3 markets
});
