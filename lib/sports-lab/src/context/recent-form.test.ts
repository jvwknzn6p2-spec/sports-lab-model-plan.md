import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRecentForm } from "./recent-form";
import { lookupBallparkFactors, SEED_PARK_COUNT } from "./ballpark";
import type { GameResult } from "../schemas";

const NOW = "2026-07-25T12:00:00Z";

function result(date: string, won: boolean, rs: number, ra: number): GameResult {
  return { date, won, runsScored: rs, runsAllowed: ra };
}

test("computeRecentForm summarizes wins and per-game runs", () => {
  const results = [
    result("2026-07-20T00:00:00Z", true, 5, 2),
    result("2026-07-21T00:00:00Z", false, 1, 4),
    result("2026-07-22T00:00:00Z", true, 7, 3),
  ];
  const form = computeRecentForm("t-1", results, 10, NOW);
  assert.equal(form.sampleSize, 3);
  assert.equal(form.wins, 2);
  assert.equal(form.losses, 1);
  assert.equal(form.runsScoredPerGame, (5 + 1 + 7) / 3);
  assert.equal(form.runsAllowedPerGame, (2 + 4 + 3) / 3);
});

test("computeRecentForm keeps only the most recent `window` games", () => {
  const results: GameResult[] = [];
  for (let d = 1; d <= 15; d++) {
    const day = String(d).padStart(2, "0");
    results.push(result(`2026-07-${day}T00:00:00Z`, d % 2 === 0, d, 1));
  }
  const form = computeRecentForm("t-1", results, 10, NOW);
  assert.equal(form.sampleSize, 10);
  // Newest 10 are days 6..15; runsScored equals the day number.
  assert.equal(form.runsScoredPerGame, (6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15) / 10);
});

test("empty results yield null per-game means and zero sample", () => {
  const form = computeRecentForm("t-1", [], 10, NOW);
  assert.equal(form.sampleSize, 0);
  assert.equal(form.runsScoredPerGame, null);
  assert.equal(form.runsAllowedPerGame, null);
});

test("known park returns non-neutral factors", () => {
  const coors = lookupBallparkFactors("v-col", "COL");
  assert.equal(coors.isNeutralFallback, false);
  assert.ok(coors.runsFactor > 1.1);
});

test("unknown park falls back to neutral 1.0 and is flagged", () => {
  const unknown = lookupBallparkFactors("v-???", "ZZZ");
  assert.equal(unknown.isNeutralFallback, true);
  assert.equal(unknown.runsFactor, 1.0);
  assert.equal(unknown.hrFactor, 1.0);
});

test("seed table covers all 30 clubs", () => {
  assert.equal(SEED_PARK_COUNT, 30);
});
