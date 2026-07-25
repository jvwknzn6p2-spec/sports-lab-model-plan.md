import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewDataAuditor } from "./data-auditor.js";
import { HeuristicReviewProvider } from "../provider.js";
import {
  CLEAN_PREDICTION,
  DATA_GAP_PREDICTION,
  SAMPLE_NOW,
} from "../sample-data.js";
import type { GamePrediction } from "../types.js";

const provider = new HeuristicReviewProvider();

function clone(pred: GamePrediction): GamePrediction {
  return structuredClone(pred);
}

test("clean prediction passes the auditor with no cap", async () => {
  const v = await reviewDataAuditor(CLEAN_PREDICTION, provider, SAMPLE_NOW);
  assert.equal(v.ok, true);
  assert.equal(v.suggestedMaxRank, null);
  assert.equal(v.source, "heuristic");
});

test("unconfirmed starter is a critical flag that caps at C", async () => {
  const v = await reviewDataAuditor(DATA_GAP_PREDICTION, provider, SAMPLE_NOW);
  const codes = v.flags.map((f) => f.code);
  assert.ok(codes.includes("UNCONFIRMED_STARTER"));
  assert.equal(v.suggestedMaxRank, "C");
  assert.equal(v.ok, false);
});

test("missing odds is critical", async () => {
  const pred = clone(CLEAN_PREDICTION);
  pred.data.oddsAvailable = false;
  const v = await reviewDataAuditor(pred, provider, SAMPLE_NOW);
  assert.ok(v.flags.some((f) => f.code === "MISSING_ODDS" && f.severity === "critical"));
  assert.equal(v.suggestedMaxRank, "C");
});

test("stale data is a warning that caps at B", async () => {
  const pred = clone(CLEAN_PREDICTION);
  // 10 hours before SAMPLE_NOW, budget 240 min.
  pred.data.fetchedAt = "2026-07-25T08:00:00Z";
  const v = await reviewDataAuditor(pred, provider, SAMPLE_NOW);
  assert.ok(v.flags.some((f) => f.code === "STALE_DATA"));
  assert.equal(v.suggestedMaxRank, "B");
});

test("moneyline probabilities that don't sum to ~1 are critical", async () => {
  const pred = clone(CLEAN_PREDICTION);
  pred.model.moneyline = { homeWinProb: 0.7, awayWinProb: 0.7 };
  const v = await reviewDataAuditor(pred, provider, SAMPLE_NOW);
  assert.ok(v.flags.some((f) => f.code === "PROB_SUM_INVALID"));
  assert.equal(v.suggestedMaxRank, "C");
});

test("implausible 0.00 ERA over many innings is flagged", async () => {
  const pred = clone(CLEAN_PREDICTION);
  pred.data.homePitcher = {
    name: "Ghost Ace",
    confirmed: true,
    era: 0,
    whip: 1.0,
    kPer9: 9,
    inningsPitched: 120,
  };
  const v = await reviewDataAuditor(pred, provider, SAMPLE_NOW);
  assert.ok(v.flags.some((f) => f.code === "IMPLAUSIBLE_STAT"));
});
