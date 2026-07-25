import { test } from "node:test";
import assert from "node:assert/strict";

import { trainLogistic, predictLogistic } from "../src/model/logistic.js";
import { fitCalibrator, applyCalibrator, IDENTITY_CALIBRATOR } from "../src/model/calibrator.js";
import { baselinePredict } from "../src/model/baseline.js";
import { mulberry32 } from "../src/util/rng.js";
import { sha256, canonicalize } from "../src/util/hash.js";

test("logistic regression learns a separable signal", () => {
  const rng = mulberry32(1);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 300; i++) {
    const a = rng() * 2 - 1;
    const b = rng() * 2 - 1;
    X.push([a, b]);
    y.push(a + b > 0 ? 1 : 0);
  }
  const model = trainLogistic(X, y, { epochs: 300 });
  assert.ok(predictLogistic(model, [1, 1]) > 0.7, "clear positive");
  assert.ok(predictLogistic(model, [-1, -1]) < 0.3, "clear negative");
});

test("calibrator is monotonic and identity when unfitted", () => {
  assert.equal(applyCalibrator(IDENTITY_CALIBRATOR, 0.42), 0.42);
  const raw = Array.from({ length: 400 }, (_, i) => i / 400);
  const rng = mulberry32(2);
  const outcomes = raw.map((p) => (rng() < p * p ? 1 : 0));
  const cal = fitCalibrator(raw, outcomes);
  assert.ok(cal.fitted);
  assert.ok(applyCalibrator(cal, 0.9) >= applyCalibrator(cal, 0.2));
});

test("baseline favors the stronger matchup", () => {
  const strongHome = baselinePredict({
    home_bat_runs_pg: 5.2, away_bat_runs_pg: 3.8,
    home_starter_era: 2.5, away_starter_era: 5.0,
    home_bullpen_era: 3.0, away_bullpen_era: 4.8,
    home_form_l10: 0.6, away_form_l10: 0.4,
    park_factor: 1.0, wind_signed: 0,
  });
  assert.ok(strongHome.homeWinProb > 0.55);
  assert.ok(strongHome.predictedTotal > 0);
});

test("hashing is deterministic and key-order independent", () => {
  assert.equal(sha256({ a: 1, b: 2 }), sha256({ b: 2, a: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("seeded rng is reproducible", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  assert.equal(a(), b());
  assert.equal(a(), b());
});
