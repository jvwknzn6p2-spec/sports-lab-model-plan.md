/**
 * Staking gates — who is allowed to put money on the book.
 *
 * Confidence C is the spec's "informational only" band (model-plan §2): a
 * C-rated game may show its prices, but no market on it is staked — real
 * line included. Every C stake the live record ever held lost (0-3, −3.00
 * units on 2026-08-18).
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
import {
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
} from "../src/engine/decision";
import { settle } from "../src/engine/settle";

const here = dirname(fileURLToPath(import.meta.url));

async function loadSlateGames() {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const source = new FixtureCoreDataSource(bundle);
  return assembleDate(bundle.date, source, { season: bundle.season });
}

test("a confidence-C game stakes nothing, even at a real line", async () => {
  const games = await loadSlateGames();
  const g = games[0]!;
  const runs = expectedRuns(g, 2024);
  // Near-even expected runs → calibrated win probability under the 55% bar →
  // PASS and confidence C, with clean, complete inputs.
  const even = simulateGame(4.05, 4.0, { sims: 10_000, seed: 3 });
  const line = { side: "home" as const, line: -1.5, total: 8.5 };
  const p = decide(g, runs, even, DEFAULT_CALIBRATION, line);

  assert.equal(p.confidence, "C");
  assert.equal(p.pass, true);
  // The price is still shown — informational is the point…
  assert.ok(p.handicap.coverProbability !== null);
  assert.ok(p.handicap.ev !== null);
  // …but the pick is withheld, so settlement can never stake it.
  assert.equal(p.handicap.pick, null);
  assert.ok(
    p.reasons.some((r) => r.includes("informational-only")),
    `reasons: ${p.reasons.join(" | ")}`,
  );

  const report = settle(
    "2024-07-25",
    [p],
    { [String(p.gamePk)]: { homeScore: 6, awayScore: 1 } },
    DEFAULT_CALIBRATION,
    new Date("2024-07-26T12:00:00Z"),
  );
  const settled = report.games[0]!;
  assert.equal(settled.handicapProfit, null, "no stake on a C game");
  assert.equal(settled.handicapCorrect, null);
});

test("the C gate does not bind B+ games: a thin-pass config keeps the handicap", async () => {
  const games = await loadSlateGames();
  const g = games[0]!;
  const runs = expectedRuns(g, 2024);
  // A strong favourite under a deliberately unreachable passThreshold: the
  // game PASSes the moneyline but still rates well above the C boundary, so
  // the real-line handicap keeps its stake (the market decoupling).
  const strong = simulateGame(6.2, 3.2, { sims: 10_000, seed: 1 });
  const line = { side: "home" as const, line: -1.5, total: 8.5 };
  const p = decide(g, runs, strong, DEFAULT_CALIBRATION, line, {
    ...DEFAULT_DECISION_CONFIG,
    passThreshold: 0.99,
  });
  assert.equal(p.pass, true);
  assert.notEqual(p.confidence, "C");
  assert.ok(p.handicap.pick !== null, "B+ handicap must survive the pass");
});
