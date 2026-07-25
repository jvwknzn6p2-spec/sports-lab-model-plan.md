import assert from "node:assert/strict";
import test from "node:test";
import {
  americanToDecimal,
  decimalToAmerican,
  devig,
  evaluateBet,
  impliedProbability,
} from "./ev";

const bet = (modelProbability: number, americanOdds: number, fairProbability: number) =>
  evaluateBet({
    market: "moneyline",
    selection: "TEST",
    grading: { kind: "moneyline", side: "home" },
    americanOdds,
    modelProbability,
    fairProbability,
    minEdge: 0.02,
    maxKelly: 0.05,
  });

test("American odds convert to decimal both ways", () => {
  assert.equal(americanToDecimal(100), 2);
  assert.equal(americanToDecimal(-100), 2);
  assert.equal(americanToDecimal(150), 2.5);
  assert.ok(Math.abs(americanToDecimal(-150) - 1.6667) < 0.0001);
  assert.equal(decimalToAmerican(2), 100);
  assert.equal(decimalToAmerican(2.5), 150);
  assert.equal(decimalToAmerican(1.5), -200);
});

test("invalid odds are rejected rather than silently coerced", () => {
  assert.throws(() => americanToDecimal(0));
  assert.throws(() => americanToDecimal(50));
  assert.throws(() => americanToDecimal(Number.NaN));
});

test("a -110/-110 market carries about 4.5% vig", () => {
  const total = impliedProbability(-110) * 2;
  assert.ok(total > 1.04 && total < 1.05, `overround was ${total}`);
});

test("both de-vig methods normalise to exactly 1", () => {
  const implied = [impliedProbability(-145), impliedProbability(125)];
  for (const method of ["proportional", "power"] as const) {
    const fair = devig(implied, method);
    const sum = fair.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${method} summed to ${sum}`);
    assert.ok(fair.every((p) => p > 0 && p < 1));
  }
});

test("de-vigging lowers both sides below their raw implied prices", () => {
  const implied = [impliedProbability(-110), impliedProbability(-110)];
  const fair = devig(implied);
  assert.ok((fair[0] as number) < (implied[0] as number));
  assert.ok(Math.abs((fair[0] as number) - 0.5) < 1e-9, "a symmetric market is 50/50 fair");
});

test("the power method loads the vig onto the longshot, not evenly", () => {
  // This is why it is the default. Proportional de-vigging shaves the same
  // *relative* amount off both sides; the power method takes far more off the
  // longshot, matching how books actually price the favourite-longshot bias.
  const implied = [impliedProbability(-400), impliedProbability(320)];
  const proportional = devig(implied, "proportional");
  const power = devig(implied, "power");

  const propShrink = [
    (proportional[0] as number) / (implied[0] as number),
    (proportional[1] as number) / (implied[1] as number),
  ];
  assert.ok(
    Math.abs(propShrink[0]! - propShrink[1]!) < 1e-9,
    "proportional shrinks both sides identically",
  );

  const powerShrink = [
    (power[0] as number) / (implied[0] as number),
    (power[1] as number) / (implied[1] as number),
  ];
  assert.ok(
    powerShrink[1]! < powerShrink[0]! - 0.05,
    `the longshot must absorb more vig: ${powerShrink[1]} vs ${powerShrink[0]}`,
  );
  // Consequence: the favourite's fair price is higher, so backing a favourite
  // needs a bigger model edge than proportional de-vigging would suggest.
  assert.ok((power[0] as number) > (proportional[0] as number));
});

test("EV is positive exactly when the model beats the fair price", () => {
  // Fair price 50%, offered at +100 (break-even 50%).
  assert.ok(bet(0.55, 100, 0.5).expectedValue > 0);
  assert.ok(Math.abs(bet(0.5, 100, 0.5).expectedValue) < 1e-12);
  assert.ok(bet(0.45, 100, 0.5).expectedValue < 0);
});

test("EV matches the hand-computed value", () => {
  // 60% at +150: 0.6 * 1.5 - 0.4 * 1 = 0.5 units per unit risked.
  const evaluation = bet(0.6, 150, 0.5);
  assert.ok(Math.abs(evaluation.expectedValue - 0.5) < 1e-12);
  assert.ok(Math.abs(evaluation.edge - 0.1) < 1e-12);
});

test("a positive-EV bet inside the minimum edge is not flagged", () => {
  const marginal = bet(0.505, 100, 0.5);
  assert.ok(marginal.expectedValue > 0, "EV is technically positive");
  assert.equal(marginal.positiveEv, false, "but a 0.5-point edge is noise, not a bet");
});

test("Kelly is zero on a losing bet and capped on a big edge", () => {
  assert.equal(bet(0.4, 100, 0.5).kellyFraction, 0);
  assert.equal(bet(0.95, 200, 0.5).kellyFraction, 0.05, "must respect the cap");
  const modest = bet(0.55, 100, 0.5).kellyFraction;
  assert.ok(modest > 0 && modest <= 0.05, `got ${modest}`);
});
