/**
 * The replay is the candidate side of a PR evaluation (judgment 2): same
 * committed slate, same lock calibration, same seeds → the current code's
 * picks, sealed with hashes and never stamped `predictedAt`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CALIBRATION } from "../src/engine/decision";
import { settle } from "../src/engine/settle";
import { calibrationAsOfCheck, replayLock, type ReplayLockInput } from "../src/engine/replay";
import type { FixtureBundle } from "../src/sources/fixture-source";
import { DEMO_GAME_PK, demoPrediction } from "./fixture-prediction";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-06T00:00:00Z");

async function fixture() {
  const bundleText = await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8");
  const bundle = JSON.parse(bundleText) as FixtureBundle;
  const pred = await demoPrediction();
  const lock: ReplayLockInput = {
    lockedAt: "2024-07-25T12:00:00Z",
    updatedAt: "2024-07-25T12:30:00Z",
    controlTower: { date: bundle.date, season: bundle.season, sims: 5000 },
    calibration: DEFAULT_CALIBRATION,
    predictions: [{ ...pred, predictedAt: "2024-07-25T12:00:00Z" }],
  };
  return { bundle, bundleText, lock };
}

test("replay is deterministic, sealed, tagged, and never carries predictedAt", async () => {
  const { bundle, bundleText, lock } = await fixture();
  const a = await replayLock({ league: "mlb", lock, bundle, bundleText, history: [], codeVersion: "head", now: NOW });
  const b = await replayLock({ league: "mlb", lock, bundle, bundleText, history: [], codeVersion: "head", now: NOW });
  assert.equal(a.source, "replay");
  assert.equal(a.predictionsSha256, b.predictionsSha256);
  assert.equal(a.predictions.length, 1);
  assert.equal(a.predictions[0]!.gamePk, DEMO_GAME_PK);
  assert.equal(a.predictions[0]!.predictedAt, undefined);
  assert.ok(a.predictions[0]!.flags.includes("[info] replay"));
  assert.equal(a.input.slateSha256.length, 64);
  assert.equal(a.calibrationAsOf.verified, null); // no history → nothing to verify against
  assert.equal(a.reproduction.inputMatched, null); // fixture lock predates inputSha256
});

test("a simulator change propagates: the candidate differs from an unchanged replay", async () => {
  const { bundle, bundleText, lock } = await fixture();
  const same = await replayLock({ league: "mlb", lock, bundle, bundleText, history: [], codeVersion: "head", now: NOW });
  const changed = await replayLock({ league: "mlb", lock, bundle, bundleText, history: [], codeVersion: "head", now: NOW, simParams: { dispersion: Infinity } });
  assert.notEqual(same.predictionsSha256, changed.predictionsSha256);
  assert.notEqual(same.predictions[0]!.rawWinProbability, changed.predictions[0]!.rawWinProbability);
});

test("calibration as-of check passes for a state rebuilt from earlier history and fails for a later one", async () => {
  const pred = await demoPrediction();
  const day1 = settle("2024-07-25", [pred], { [DEMO_GAME_PK]: { homeScore: 2, awayScore: 6 } }, DEFAULT_CALIBRATION, NOW);
  const day2 = settle("2024-07-26", [pred], { [DEMO_GAME_PK]: { homeScore: 6, awayScore: 2 } }, DEFAULT_CALIBRATION, NOW);
  const history = [day1, day2];
  // A lock for 07-26 must carry the state learned from 07-25 only.
  const okState = calibrationAsOfCheck(day1.calibrationAfter, history, "2024-07-26");
  assert.equal(okState.verified, true);
  assert.equal(okState.historyRowsBefore, 1);
  // A lock for 07-26 carrying the state that already saw 07-26's result is not as-of.
  const leaked = calibrationAsOfCheck(day2.calibrationAfter, history, "2024-07-26");
  assert.equal(leaked.verified, false);
  assert.ok(leaked.differences.length > 0);
});
