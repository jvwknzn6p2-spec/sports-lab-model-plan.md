import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { HeuristicReviewProvider } from "@workspace/ai-review";
import { train } from "../src/train.js";
import { runPredict, runSettle } from "../src/pipeline.js";
import { FixtureSource } from "../src/adapters/index.js";
import { outPath } from "../src/config.js";

const DATE = "2026-07-25";
const NOW = new Date("2026-07-25T18:00:00Z");

function opts() {
  return { source: new FixtureSource(), provider: new HeuristicReviewProvider(), now: NOW };
}

test("e2e: train → predict → settle on fixtures", async () => {
  const metrics = train();
  assert.ok(metrics.auc > 0.55, `expected a real signal, got AUC ${metrics.auc}`);

  const lock = await runPredict(DATE, opts());
  assert.equal(lock.games.length, 3);
  assert.ok(existsSync(outPath(`locked_${DATE}.json`)));
  assert.ok(existsSync(outPath(`manifest_${DATE}.json`)));

  const hou = lock.games.find((g) => g.gameId.endsWith("HOU"))!;
  const bos = lock.games.find((g) => g.gameId.endsWith("BOS"))!;

  // Strong, clean home favorite → a real PLAY on HOU.
  assert.equal(hou.decision, "PLAY");
  assert.equal(hou.winner, "HOU");

  // Unconfirmed starter + stale data → AI review forces confidence C → PASS.
  assert.equal(bos.confidence, "C");
  assert.equal(bos.decision, "PASS");
  assert.ok(bos.passReason?.includes("review"));

  // Settlement + error analysis + self-learning.
  const { report, learning, settled } = await runSettle(DATE, opts());
  assert.equal(report.nGames, 3);
  assert.equal(settled.settled.length, 3);
  assert.ok(report.winnerAccuracy >= 0 && report.winnerAccuracy <= 1);
  assert.ok(learning.rationale.length > 0);
  assert.ok(existsSync(outPath(`settled_${DATE}.json`)));
  assert.ok(existsSync(outPath(`error_report_${DATE}.json`)));
});

test("e2e: runs are reproducible (identical content hashes)", async () => {
  train();
  const a = await runPredict(DATE, opts());
  const b = await runPredict(DATE, opts());
  for (let i = 0; i < a.games.length; i++) {
    assert.equal(a.games[i]!.contentHash, b.games[i]!.contentHash, `game ${i} hash drift`);
  }
});
