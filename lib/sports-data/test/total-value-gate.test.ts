/**
 * The totals market answers to the same value discipline as every other
 * market — the gate it historically lacked.
 *
 * The first 7 settled totals went 2-5, saying 59.7% and hitting 28.6%,
 * because a quoted total was picked at "whichever side of 50%" with no
 * break-even bar at all: a 51% opinion at a book that pays 0.9 on a win is a
 * guaranteed long-run loss quoted as a pick. And since ODDS_API_KEY fills
 * market totals onto nearly every game, the missing gate would have scaled
 * into the book's biggest leak.
 *
 * Two refusals, both leaving the price on display (informational is the
 * point, exactly as with the handicap and confidence C):
 *   - EV ≤ minEv: the stated probability cannot clear the house's cut;
 *   - market disagreement ≥ MARKET_DISAGREEMENT_THRESHOLD on this exact
 *     line: the totals record has earned no trust, so unlike the handicap
 *     (confidence cap only) the pick itself is withheld.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleDate } from "../src/step2";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../src/sources/fixture-source";
import { expectedRuns } from "../src/engine/run-model";
import { simulateGame } from "../src/engine/simulate";
import { decide, DEFAULT_CALIBRATION } from "../src/engine/decision";
import { breakEvenProbability } from "../src/engine/ev";

const here = dirname(fileURLToPath(import.meta.url));

async function loadGame() {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const source = new FixtureCoreDataSource(bundle);
  const games = await assembleDate(bundle.date, source, {
    season: bundle.season,
  });
  return games[0]!;
}

// A clear favourite so the game itself is never PASSed — the totals gate is
// what is under test, not the winner gate.
const FAVOURITE = { home: 5.4, away: 3.6 };

test("a total the model likes clears the gate and carries its EV", async () => {
  const g = await loadGame();
  const runs = expectedRuns(g, 2024);
  const sim = simulateGame(FAVOURITE.home, FAVOURITE.away, {
    sims: 10_000,
    seed: 11,
  });
  // Mean total ≈ 9 runs; a 7.5 line is far enough under it that the OVER
  // clears break-even comfortably at any seed.
  const p = decide(g, runs, sim, DEFAULT_CALIBRATION, {
    side: "home",
    line: -1.5,
    total: 7.5,
  });

  assert.equal(p.pass, false);
  assert.equal(p.total.pick, "OVER");
  assert.ok(p.total.ev != null && p.total.ev > 0, `ev: ${p.total.ev}`);
  assert.equal(p.total.noValue, false);
});

test("a near-coin-flip total is refused: the price shows, the pick is withheld", async () => {
  const g = await loadGame();
  const runs = expectedRuns(g, 2024);
  const sim = simulateGame(FAVOURITE.home, FAVOURITE.away, {
    sims: 10_000,
    seed: 11,
  });
  // A line pinned to the simulation's own mean total: whichever side the
  // model leans, the calibrated probability lands under the ~52.6% the
  // 10% cut demands.
  const line = Math.round(sim.meanTotal * 2) / 2;
  const p = decide(g, runs, sim, DEFAULT_CALIBRATION, {
    side: "home",
    line: -1.5,
    total: line,
  });

  assert.equal(p.pass, false);
  assert.ok(
    p.total.ev !== null && p.total.ev! <= 0,
    `expected a sub-break-even total at the mean, got EV ${p.total.ev}`,
  );
  // The refusal: pick withheld, price still on display.
  assert.equal(p.total.pick, null);
  assert.equal(p.total.noValue, true);
  assert.ok(p.total.probability !== null);
  assert.ok(
    p.reasons.some((r) => r.includes("No total bet")),
    `reasons: ${p.reasons.join(" | ")}`,
  );
});

test("a total far from the market consensus is refused even with loud EV", async () => {
  const g = await loadGame();
  const runs = expectedRuns(g, 2024);
  const sim = simulateGame(FAVOURITE.home, FAVOURITE.away, {
    sims: 10_000,
    seed: 11,
  });
  // Model: OVER 7.5 with a real edge. Market: leaning UNDER on the same
  // line — a disagreement well past MARKET_DISAGREEMENT_THRESHOLD, which
  // history says is model error, not value.
  const p = decide(g, runs, sim, DEFAULT_CALIBRATION, {
    side: "home",
    line: -1.5,
    total: 7.5,
    marketOver: 0.42,
  });

  assert.ok(p.total.ev != null && p.total.ev > 0, `ev: ${p.total.ev}`);
  assert.equal(p.total.pick, null);
  assert.equal(p.total.noValue, true);
  assert.ok(p.flags.includes("[warn] total_market_disagreement"), String(p.flags));
  assert.ok(
    p.reasons.some((r) => r.includes("disagreement this large")),
    `reasons: ${p.reasons.join(" | ")}`,
  );
});

test("a whole-number line's push share is priced, not ignored", () => {
  const sim = simulateGame(FAVOURITE.home, FAVOURITE.away, {
    sims: 10_000,
    seed: 11,
  });
  // A half-run line cannot land exactly; a whole-number line near the mean
  // lands exactly in a meaningful share of simulations, and that share is
  // returned money — excluded from the risk, exactly as asianCover treats a
  // run-line push.
  assert.equal(sim.totalProb(8.5).push, 0);
  const whole = sim.totalProb(9);
  assert.ok(whole.push > 0.05, `push share: ${whole.push}`);
  // Conditional over/under still sum to 1 among decided simulations.
  assert.ok(Math.abs(whole.over + whole.under - 1) < 1e-9);
});

test("break-even discipline matches the book's arithmetic", () => {
  // The gate's bar is not a magic number: 52.63% is what a 10% cut implies.
  assert.ok(Math.abs(breakEvenProbability() - 1 / 1.9) < 1e-9);
});
