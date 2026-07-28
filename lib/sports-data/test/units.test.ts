import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inningsToOuts,
  inningsToDecimal,
  outsToNotation,
  InningsParseError,
  rate,
  round,
} from "../src/sabermetrics/units";

test("innings notation is base-3 outs, not decimal", () => {
  assert.equal(inningsToOuts("180.0"), 540);
  assert.equal(inningsToOuts("180.1"), 541);
  assert.equal(inningsToOuts("180.2"), 542);
  assert.equal(inningsToOuts("180"), 540);
});

test("numeric innings carrying the outs convention", () => {
  assert.equal(inningsToOuts(180.1), 541);
  assert.equal(inningsToOuts(180.2), 542);
  assert.equal(inningsToOuts(180), 540);
});

test("inningsToDecimal converts thirds correctly", () => {
  assert.ok(Math.abs(inningsToDecimal("180.1") - 180.3333) < 0.001);
});

test("round-trips through notation", () => {
  assert.equal(outsToNotation(541), "180.1");
  assert.equal(outsToNotation(542), "180.2");
  assert.equal(outsToNotation(540), "180.0");
});

test("invalid innings fail loudly", () => {
  assert.throws(() => inningsToOuts("180.3"), InningsParseError);
  assert.throws(() => inningsToOuts("abc"), InningsParseError);
  assert.throws(() => inningsToOuts(-5), InningsParseError);
});

test("rate returns null on zero denominator, never NaN", () => {
  assert.equal(rate(5, 0), null);
  assert.equal(rate(6, 2), 3);
  assert.equal(round(null), null);
  assert.equal(round(1.23456, 2), 1.23);
});
