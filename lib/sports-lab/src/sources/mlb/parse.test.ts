import assert from "node:assert/strict";
import test from "node:test";
import { cacheKeyToPath } from "../http";
import { deriveAbbrev, parseInningsPitched, per9, statNumber } from "./parse";

test("innings pitched parse out of baseball notation", () => {
  // ".1" and ".2" mean one and two thirds of an inning, not tenths.
  assert.equal(parseInningsPitched("112.0"), 112);
  assert.ok(Math.abs((parseInningsPitched("112.1") as number) - 112.3333333) < 1e-6);
  assert.ok(Math.abs((parseInningsPitched("112.2") as number) - 112.6666666) < 1e-6);
  assert.equal(parseInningsPitched("0.1"), 1 / 3);
  assert.equal(parseInningsPitched(45), 45);
  assert.equal(parseInningsPitched(""), null);
  assert.equal(parseInningsPitched(undefined), null);
  assert.equal(parseInningsPitched(null), null);
});

test("stat numbers survive the API's string formatting", () => {
  assert.equal(statNumber(".312"), 0.312);
  assert.equal(statNumber("3.45"), 3.45);
  assert.equal(statNumber("-1.5"), -1.5);
  assert.equal(statNumber(4.4), 4.4);
  assert.equal(statNumber(0), 0);
});

test("unusable stat values become null, never zero", () => {
  // This matters: a pitcher with no innings has an ERA of "-.--", and treating
  // that as 0.00 would make them look like the best arm in baseball.
  assert.equal(statNumber("-.--"), null);
  assert.equal(statNumber(".---"), null);
  assert.equal(statNumber("-"), null);
  assert.equal(statNumber(""), null);
  assert.equal(statNumber("  "), null);
  assert.equal(statNumber(undefined), null);
  assert.equal(statNumber(null), null);
  assert.equal(statNumber(Number.NaN), null);
  assert.equal(statNumber({}), null);
});

test("per-9 rates refuse to divide by zero innings", () => {
  assert.equal(per9(45, 90), 4.5);
  assert.equal(per9(45, 0), null);
  assert.equal(per9(45, null), null);
  assert.equal(per9(null, 90), null);
});

test("abbreviations are derived when the API omits them", () => {
  assert.equal(deriveAbbrev("Harbor City Herons"), "HCH");
  assert.equal(deriveAbbrev("Riverside Rockets"), "ROC");
  assert.equal(deriveAbbrev("Athletics"), "ATH");
  assert.equal(deriveAbbrev(""), "???");
  // Always exactly three characters, whatever the input.
  for (const name of ["A", "A B", "A B C", "A B C D E"]) {
    assert.equal(deriveAbbrev(name).length, 3, `"${name}" produced a bad abbreviation`);
  }
});

test("cache keys become safe relative paths", () => {
  assert.equal(cacheKeyToPath("mlb/schedule/2026-07-24"), "mlb/schedule/2026-07-24.json");
  assert.equal(cacheKeyToPath("mlb/pitchers/2026-1001_1002"), "mlb/pitchers/2026-1001_1002.json");
  // Traversal and odd characters must not escape the cache directory.
  assert.equal(cacheKeyToPath("../../etc/passwd"), "etc/passwd.json");
  assert.equal(cacheKeyToPath("a b/c:d"), "a-b/c-d.json");
  assert.throws(() => cacheKeyToPath(""));
  assert.throws(() => cacheKeyToPath("///"));
});
