import { test } from "node:test";
import assert from "node:assert/strict";
import {
  americanToDecimal,
  decimalToAmerican,
  impliedProbability,
  InvalidOddsError,
  overround,
  removeVig,
  removeVigAmerican,
} from "./conversion";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

test("American to decimal for underdog prices", () => {
  assert.ok(close(americanToDecimal(100), 2));
  assert.ok(close(americanToDecimal(130), 2.3));
  assert.ok(close(americanToDecimal(250), 3.5));
});

test("American to decimal for favourite prices", () => {
  assert.ok(close(americanToDecimal(-100), 2));
  assert.ok(close(americanToDecimal(-150), 1 + 100 / 150));
  assert.ok(close(americanToDecimal(-200), 1.5));
});

test("decimal to American round-trips", () => {
  for (const odds of [-250, -150, -110, 100, 120, 175, 400]) {
    assert.ok(
      close(decimalToAmerican(americanToDecimal(odds)), odds, 1e-9),
      `round-trip failed for ${odds}`,
    );
  }
});

test("even money is canonicalised to +100", () => {
  // -100 and +100 are the same price, so the round trip cannot preserve both.
  assert.ok(close(americanToDecimal(-100), americanToDecimal(100)));
  assert.equal(decimalToAmerican(2), 100);
});

test("odds inside (-100, 100) are rejected", () => {
  assert.throws(() => americanToDecimal(0), InvalidOddsError);
  assert.throws(() => americanToDecimal(50), InvalidOddsError);
  assert.throws(() => americanToDecimal(-99), InvalidOddsError);
  assert.throws(() => americanToDecimal(Number.NaN), InvalidOddsError);
});

test("decimal odds must exceed 1", () => {
  assert.throws(() => decimalToAmerican(1), RangeError);
  assert.throws(() => impliedProbability(0.5), RangeError);
});

test("implied probability is the reciprocal of decimal odds", () => {
  assert.ok(close(impliedProbability(2), 0.5));
  assert.ok(close(impliedProbability(4), 0.25));
});

test("a -110/-110 market carries roughly a 4.8% overround", () => {
  const total = overround([americanToDecimal(-110), americanToDecimal(-110)]);
  assert.ok(total > 1.04 && total < 1.05, `overround was ${total}`);
});

test("removing the vig produces probabilities summing to exactly 1", () => {
  const probs = removeVig([americanToDecimal(-110), americanToDecimal(-110)]);
  assert.ok(close(probs[0] + probs[1], 1));
  // A symmetric market must de-vig to an even split.
  assert.ok(close(probs[0], 0.5));
});

test("de-vigging preserves the favourite/underdog ordering", () => {
  const { a: home, b: away } = removeVigAmerican(-200, 170);
  assert.ok(home > away, "the favourite must stay more likely");
  assert.ok(close(home + away, 1));
  // Raw implied probabilities would have summed above 1.
  assert.ok(home < impliedProbability(americanToDecimal(-200)));
});

test("de-vigged probabilities sit below their raw implied values", () => {
  const raw = [impliedProbability(americanToDecimal(-150)), impliedProbability(americanToDecimal(130))];
  const fair = removeVig([americanToDecimal(-150), americanToDecimal(130)]);
  assert.ok(fair[0] < raw[0], "vig removal must reduce each side");
  assert.ok(fair[1] < raw[1]);
});

test("an empty market de-vigs to an empty result", () => {
  assert.deepEqual(removeVig([]), []);
});
