import { test } from "node:test";
import assert from "node:assert/strict";

import { applyReview, capAt, downgrade, minRank, rankIndex } from "./confidence.js";
import type { AgentVerdict } from "./types.js";

function verdict(
  agent: AgentVerdict["agent"],
  suggestedMaxRank: AgentVerdict["suggestedMaxRank"],
): AgentVerdict {
  return {
    agent,
    ok: suggestedMaxRank === null,
    flags: [],
    suggestedMaxRank,
    reasoning: "",
    source: "heuristic",
  };
}

test("rankIndex orders S..C ascending", () => {
  assert.equal(rankIndex("S"), 0);
  assert.equal(rankIndex("A"), 1);
  assert.equal(rankIndex("B"), 2);
  assert.equal(rankIndex("C"), 3);
});

test("minRank returns the more conservative rank", () => {
  assert.equal(minRank("A", "C"), "C");
  assert.equal(minRank("C", "A"), "C");
  assert.equal(minRank("S", "S"), "S");
});

test("downgrade never upgrades and clamps at C", () => {
  assert.equal(downgrade("S", 1), "A");
  assert.equal(downgrade("S", 2), "B");
  assert.equal(downgrade("B", 5), "C"); // clamp
  assert.equal(downgrade("A", 0), "A");
  assert.equal(downgrade("A", -3), "A"); // negative treated as 0
});

test("capAt only lowers", () => {
  assert.equal(capAt("S", "B"), "B");
  assert.equal(capAt("C", "S"), "C"); // cap can't raise
});

test("applyReview takes the most conservative cap", () => {
  const final = applyReview("S", [
    verdict("data-auditor", "A"),
    verdict("matchup-analyst", null),
    verdict("risk-reviewer", "B"),
  ]);
  assert.equal(final, "B");
});

test("applyReview never raises confidence above the original", () => {
  // Even if every agent suggests a *higher* rank than the original, the result
  // stays at the original — AI can only downgrade.
  const final = applyReview("C", [
    verdict("data-auditor", "S"),
    verdict("risk-reviewer", "A"),
  ]);
  assert.equal(final, "C");
});

test("applyReview with no caps preserves the original", () => {
  const final = applyReview("A", [
    verdict("data-auditor", null),
    verdict("matchup-analyst", null),
    verdict("risk-reviewer", null),
  ]);
  assert.equal(final, "A");
});
