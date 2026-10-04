/**
 * Calibration learning paused (judgment 3): `settle` must leave
 * calibration.json untouched while recording what learning would have done
 * to calibration-shadow.json, and history must say so. Exercised through
 * the CLI against a throwaway copy of a store, because the file writes are
 * the behaviour under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CALIBRATION } from "../src/engine/decision";
import { demoPrediction, DEMO_GAME_PK } from "./fixture-prediction";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

async function store(frozen: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "freeze-"));
  mkdirSync(join(dir, "predictions"), { recursive: true });
  const pred = await demoPrediction();
  writeFileSync(
    join(dir, "predictions", "2024-07-25.json"),
    JSON.stringify({ lockedAt: "2024-07-25T12:00:00Z", controlTower: { date: "2024-07-25", season: 2024 }, calibration: DEFAULT_CALIBRATION, predictions: [pred] }),
  );
  writeFileSync(
    join(dir, "calibration.json"),
    JSON.stringify({ ...DEFAULT_CALIBRATION, ...(frozen ? { frozen: { since: "2026-09-06T00:00:00Z", reason: "test" } } : {}) }),
  );
  writeFileSync(join(dir, "results.json"), JSON.stringify({ date: "2024-07-25", results: { [DEMO_GAME_PK]: { homeScore: 2, awayScore: 6 } } }));
  return dir;
}

function settleVia(dir: string): void {
  execFileSync("pnpm", ["exec", "tsx", "src/cli/handiedge.ts", "settle", "--data-dir", dir, "--results", join(dir, "results.json")], {
    cwd: PKG,
    stdio: "pipe",
    env: { ...process.env, HANDIEDGE_CODE_VERSION: "test" },
  });
}

test("frozen: calibration.json is untouched, the shadow records the would-be state, history says so", async () => {
  const dir = await store(true);
  const before = readFileSync(join(dir, "calibration.json"), "utf8");
  settleVia(dir);
  assert.equal(readFileSync(join(dir, "calibration.json"), "utf8"), before);
  const shadow = JSON.parse(readFileSync(join(dir, "calibration-shadow.json"), "utf8"));
  assert.equal(shadow.gamesSettled, 1);
  assert.equal(shadow.frozen, undefined);
  assert.equal(shadow.frozenSince, "2026-09-06T00:00:00Z");
  const [report] = readFileSync(join(dir, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(report.calibrationAfter.shrink, DEFAULT_CALIBRATION.shrink);
  assert.equal(report.settlementRule, "MLB_FINAL_SCORE/v1"); // every new history row names its rule
  assert.ok(report.calibrationAfter.frozen);
  assert.equal(report.calibrationShadowAfter.gamesSettled, 1);
});

test("not frozen: learning still updates calibration.json as before", async () => {
  const dir = await store(false);
  settleVia(dir);
  const after = JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8"));
  assert.equal(after.gamesSettled, 1);
  assert.equal(after.frozen, undefined);
});
