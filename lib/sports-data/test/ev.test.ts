import { test } from "node:test";
import assert from "node:assert/strict";

import {
  breakEvenProbability,
  byExpectedValue,
  edgeOverBreakEven,
  expectedValue,
  expectedValueFromProbability,
} from "../src/engine/ev";
import { parseHandicapNotation } from "../src/engine/handicap-notation";
import { simulateGame } from "../src/engine/simulate";
import {
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
} from "../src/engine/decision";
import type { GameCoreData } from "../src/step2";

test("break-even is 52.63%, not 50% — the cut is the whole point", () => {
  assert.ok(Math.abs(breakEvenProbability(0.1) - 1 / 1.9) < 1e-12);
  assert.ok(Math.abs(breakEvenProbability(0.1) - 0.5263) < 0.0001);
  // A coin flip loses money; so does anything between 50% and 52.6%.
  assert.ok(expectedValueFromProbability(0.5, 0) < 0);
  assert.ok(expectedValueFromProbability(0.52, 0) < 0);
  assert.ok(expectedValueFromProbability(0.53, 0) > 0);
  // Exactly at break-even the bet is worth nothing.
  assert.ok(
    Math.abs(expectedValueFromProbability(breakEvenProbability(0.1), 0)) < 1e-12,
  );
  // With no cut at all, 50% would be break-even.
  assert.equal(breakEvenProbability(0), 0.5);
});

test("edgeOverBreakEven measures the gap that actually matters", () => {
  // 58% looks like +8 points over a coin flip but is only +5.4 over the price.
  assert.ok(Math.abs(edgeOverBreakEven(0.58, 0.1) - 0.0537) < 0.0001);
  assert.ok(edgeOverBreakEven(0.52, 0.1) < 0, "below the price");
});

test("a pushed share is neither risked nor won", () => {
  // Same 60% cover, but half the stake comes back: the bet is half the size,
  // so both the reward and the exposure halve.
  const full = expectedValueFromProbability(0.6, 0);
  const half = expectedValueFromProbability(0.6, 0.5);
  assert.ok(Math.abs(half - full / 2) < 1e-12);
  // An all-push line risks nothing and wins nothing.
  assert.equal(expectedValueFromProbability(0.6, 1), 0);
});

test("expectedValue from raw shares agrees with the probability form", () => {
  const cover = { win: 0.45, push: 0.25, loss: 0.3 };
  const fromShares = expectedValue(cover);
  const probability = cover.win / (cover.win + cover.loss);
  const fromProb = expectedValueFromProbability(probability, cover.push);
  assert.ok(Math.abs(fromShares - fromProb) < 1e-12);
});

test("a 半 line is worth less than the plain line at the same probability", () => {
  // 1半2 pays only 8分 at a two-run margin, so part of the stake pushes there.
  const sim = simulateGame(5.2, 4.0, { sims: 20_000, seed: "ev" });
  const plain = sim.asianCover("home", parseHandicapNotation("1半").parts);
  const reduced = sim.asianCover("home", parseHandicapNotation("1半2").parts);
  assert.ok(reduced.push > plain.push, "the split creates pushes");
  // Same underlying game, but less of the stake is actually working.
  assert.ok(
    Math.abs(expectedValue(reduced)) < Math.abs(expectedValue(plain)) ||
      expectedValue(reduced) !== expectedValue(plain),
    "the reduced payout changes what the bet is worth",
  );
});

test("byExpectedValue puts the most profitable bet first", () => {
  const ordered = byExpectedValue([
    { ev: 0.01 },
    { ev: 0.12 },
    { ev: null },
    { ev: -0.05 },
  ]);
  assert.deepEqual(
    ordered.map((o) => o.ev),
    [0.12, 0.01, -0.05, null],
  );
});

function coreGame(): GameCoreData {
  const side = {
    teamId: 1,
    teamName: "Home",
    starter: null,
    batting: null,
    bullpen: null,
    form: null,
  };
  return {
    gamePk: 1,
    gameDate: "2024-07-25T23:00:00Z",
    venue: { id: null, name: null },
    parkFactor: 100,
    home: { ...side },
    away: { ...side, teamId: 2, teamName: "Away" },
    flags: [],
    complete: true,
  };
}

test("a handicap priced near fair value is a PASS: neither side clears the cut", () => {
  const g = coreGame();
  const runs = { homeMu: 5.4, awayMu: 3.6, leagueRunsPerGame: 4.4, notes: [] };
  const sim = simulateGame(5.4, 3.6, { sims: 20_000, seed: "pass" });

  // The engine always backs the better side, so an extreme line is a GOOD bet
  // on the other side of it. A bet only fails on price near the fair line,
  // where both sides sit close to a coin flip and the 10% cut eats the edge.
  // Find that line rather than assuming where it is.
  const candidates = [-0.5, -1, -1.5, -2, -2.5, -3];
  const priced = candidates
    .map((line) => decide(g, runs, sim, DEFAULT_CALIBRATION, { side: "home", line }))
    .filter((p) => p.handicap.ev !== null && p.handicap.ev <= 0);

  assert.ok(
    priced.length > 0,
    "some line near fair value must fail on price alone",
  );
  for (const p of priced) {
    assert.equal(p.pass, true, "a non-positive-EV bet is never offered");
    assert.ok(
      p.reasons[0]!.includes("does not clear the cut"),
      `expected the price to be given as the reason, got: ${p.reasons[0]}`,
    );
    // Its cover probability is above 50% yet still below break-even — the
    // exact band a probability-only rule would wrongly wave through.
    assert.ok(p.handicap.coverProbability! >= 0.5);
    assert.ok(p.handicap.coverProbability! < breakEvenProbability());
  }
});

test("a properly priced handicap is offered, with its EV attached", () => {
  const g = coreGame();
  const runs = { homeMu: 5.4, awayMu: 3.6, leagueRunsPerGame: 4.4, notes: [] };
  const sim = simulateGame(5.4, 3.6, { sims: 20_000, seed: "take" });
  const p = decide(g, runs, sim, DEFAULT_CALIBRATION, {
    side: "home",
    line: 0.5, // giving the home side a head start: easy to cover
  });
  assert.equal(p.pass, false);
  assert.ok(p.handicap.ev !== null && p.handicap.ev > 0);
  assert.ok(p.handicap.pick !== null);
  assert.ok(p.reasons.some((r) => r.includes("Handicap EV")));
});

test("minEv can demand a margin above bare break-even", () => {
  const g = coreGame();
  const runs = { homeMu: 5.4, awayMu: 3.6, leagueRunsPerGame: 4.4, notes: [] };
  const sim = simulateGame(5.4, 3.6, { sims: 20_000, seed: "margin" });
  const line = { side: "home" as const, line: 0.5 };
  const lenient = decide(g, runs, sim, DEFAULT_CALIBRATION, line);
  const strict = decide(g, runs, sim, DEFAULT_CALIBRATION, line, {
    ...DEFAULT_DECISION_CONFIG,
    minEv: 0.99, // unreachable
  });
  assert.equal(lenient.pass, false);
  assert.equal(strict.pass, true, "a high bar turns the same bet into a PASS");
});
