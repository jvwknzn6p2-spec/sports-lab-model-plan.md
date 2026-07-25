import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewPrediction, reviewSlate } from "./orchestrator.js";
import { HeuristicReviewProvider, type ReviewProvider } from "./provider.js";
import type { ReasonOutcome } from "./provider.js";
import {
  CLEAN_PREDICTION,
  DATA_GAP_PREDICTION,
  OVERCONFIDENT_PREDICTION,
  SAMPLE_SLATE,
  SAMPLE_NOW,
} from "./sample-data.js";

const offline = new HeuristicReviewProvider();

test("clean prediction keeps its rank and reports no warnings", async () => {
  const r = await reviewPrediction(CLEAN_PREDICTION, {
    provider: offline,
    now: SAMPLE_NOW,
  });
  assert.equal(r.finalConfidence, "A");
  assert.equal(r.downgraded, false);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.verdicts.length, 3);
});

test("data-gap prediction is downgraded to C by the auditor", async () => {
  const r = await reviewPrediction(DATA_GAP_PREDICTION, {
    provider: offline,
    now: SAMPLE_NOW,
  });
  assert.equal(r.finalConfidence, "C");
  assert.equal(r.downgraded, true);
  assert.ok(r.warnings.some((w) => w.includes("downgraded")));
});

test("over-confident S pick is capped by the risk reviewer", async () => {
  const r = await reviewPrediction(OVERCONFIDENT_PREDICTION, {
    provider: offline,
    now: SAMPLE_NOW,
  });
  // Thin edge + low agreement + coin flip → should be well below S.
  assert.notEqual(r.finalConfidence, "S");
  assert.ok(r.flags.some((f) => f.agent === "risk-reviewer"));
});

test("review never raises confidence above the original", async () => {
  const r = await reviewSlate(SAMPLE_SLATE, { provider: offline, now: SAMPLE_NOW });
  for (const result of r) {
    const order = ["S", "A", "B", "C"];
    assert.ok(
      order.indexOf(result.finalConfidence) >=
        order.indexOf(result.originalConfidence),
      `${result.gameId}: ${result.originalConfidence} -> ${result.finalConfidence} raised confidence`,
    );
  }
});

test("flags are sorted most-severe first", async () => {
  const r = await reviewPrediction(DATA_GAP_PREDICTION, {
    provider: offline,
    now: SAMPLE_NOW,
  });
  const weight = { critical: 0, warning: 1, info: 2 };
  for (let i = 1; i < r.flags.length; i++) {
    assert.ok(
      weight[r.flags[i - 1]!.severity] <= weight[r.flags[i]!.severity],
      "flags not sorted by severity",
    );
  }
});

test("reviewSlate preserves input order under concurrency", async () => {
  const r = await reviewSlate(SAMPLE_SLATE, {
    provider: offline,
    now: SAMPLE_NOW,
    concurrency: 3,
  });
  assert.deepEqual(
    r.map((x) => x.gameId),
    SAMPLE_SLATE.map((p) => p.gameId),
  );
});

/**
 * A fake provider that returns a fixed LLM verdict, to prove the LLM pass is
 * merged in and that its cap composes with the deterministic caps. Even when
 * the LLM tries to keep an over-confident pick at "S", the deterministic risk
 * rules still cap it — the strictest cap wins.
 */
class StubProvider implements ReviewProvider {
  readonly kind = "stub";
  readonly available = true;
  constructor(private readonly outcome: ReasonOutcome) {}
  async reason(): Promise<ReasonOutcome> {
    return this.outcome;
  }
}

test("LLM concerns are merged and the strictest cap wins", async () => {
  const stub = new StubProvider({
    ok: true,
    note: "ok",
    verdict: {
      concerns: [
        { code: "LLM_PITCHER_TREND", severity: "warning", message: "Ace trending down." },
      ],
      suggestedMaxRank: "S", // LLM is lenient...
      overallAssessment: "Looks fine to me.",
    },
  });
  const r = await reviewPrediction(OVERCONFIDENT_PREDICTION, {
    provider: stub,
    now: SAMPLE_NOW,
  });
  // ...but deterministic risk rules still cap the over-confident pick.
  assert.notEqual(r.finalConfidence, "S");
  assert.ok(r.flags.some((f) => f.code === "LLM_PITCHER_TREND"));
  assert.ok(r.verdicts.every((v) => v.source === "heuristic+llm"));
});

test("provider failure degrades gracefully to deterministic review", async () => {
  const failing = new StubProvider({
    ok: false,
    verdict: null,
    note: "refusal",
  });
  const r = await reviewPrediction(DATA_GAP_PREDICTION, {
    provider: failing,
    now: SAMPLE_NOW,
  });
  // Still downgraded by the deterministic auditor; failure noted, not thrown.
  assert.equal(r.finalConfidence, "C");
  assert.ok(r.verdicts.some((v) => v.reasoning.includes("refusal")));
});
