import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatNumber, parseInningsPitched } from "./numeric";

test("parseStatNumber handles strings, leading dots, and numbers", () => {
  assert.equal(parseStatNumber(".330"), 0.33);
  assert.equal(parseStatNumber("2.85"), 2.85);
  assert.equal(parseStatNumber("480"), 480);
  assert.equal(parseStatNumber(3.9), 3.9);
  assert.equal(parseStatNumber("-1.2"), -1.2);
});

test("parseStatNumber returns null for absent/sentinel values", () => {
  assert.equal(parseStatNumber(null), null);
  assert.equal(parseStatNumber(undefined), null);
  assert.equal(parseStatNumber(""), null);
  assert.equal(parseStatNumber("   "), null);
  assert.equal(parseStatNumber("-"), null);
  assert.equal(parseStatNumber("-.--"), null);
  assert.equal(parseStatNumber(".---"), null);
  assert.equal(parseStatNumber(NaN), null);
  assert.equal(parseStatNumber({}), null);
});

// The core correctness case: .1/.2 are OUTS (thirds), not tenths.
test("parseInningsPitched reads baseball thirds notation", () => {
  assert.equal(parseInningsPitched("120.0"), 120);
  assert.equal(parseInningsPitched("120"), 120);
  assert.ok(Math.abs((parseInningsPitched("120.1") ?? 0) - (120 + 1 / 3)) < 1e-9);
  assert.ok(Math.abs((parseInningsPitched("120.2") ?? 0) - (120 + 2 / 3)) < 1e-9);
  assert.equal(parseInningsPitched("0.1"), 1 / 3);
});

test("parseInningsPitched returns null for absent values", () => {
  assert.equal(parseInningsPitched(null), null);
  assert.equal(parseInningsPitched(""), null);
  assert.equal(parseInningsPitched("-.--"), null);
});

test("parseInningsPitched falls back gracefully on out-of-spec fractions", () => {
  // .5 is not valid thirds notation; do not pretend otherwise, just read it.
  assert.equal(parseInningsPitched("10.5"), 10.5);
});
