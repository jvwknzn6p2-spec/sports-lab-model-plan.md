import assert from "node:assert/strict";
import test from "node:test";
import {
  brierScore,
  calibrationBins,
  createRng,
  fitPlattScaling,
  logLoss,
  logit,
  percentile,
  sampleNegativeBinomial,
  samplePoisson,
  shrink,
  sigmoid,
} from "./math";

test("the RNG is deterministic for a seed and different across seeds", () => {
  const a = createRng("seed-a");
  const b = createRng("seed-a");
  const c = createRng("seed-b");
  const first = Array.from({ length: 5 }, () => a.next());
  const second = Array.from({ length: 5 }, () => b.next());
  const third = Array.from({ length: 5 }, () => c.next());
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, third);
  for (const value of first) {
    assert.ok(value >= 0 && value < 1, `${value} out of range`);
  }
});

test("Poisson samples match their mean", () => {
  const rng = createRng("poisson");
  const n = 40000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samplePoisson(rng, 4.4);
  assert.ok(Math.abs(sum / n - 4.4) < 0.05, `mean was ${sum / n}`);
});

test("the negative binomial reproduces the overdispersion MLB runs actually show", () => {
  // k = 4.2 at mu = 4.4 should give variance mu + mu^2/k ~= 9.0, roughly double
  // Poisson. This is the whole reason simulate.ts does not use Poisson.
  const rng = createRng("nb");
  const n = 200000;
  const mu = 4.4;
  const k = 4.2;
  const values: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const value = sampleNegativeBinomial(rng, mu, k);
    values.push(value);
    sum += value;
  }
  const observedMean = sum / n;
  const variance =
    values.reduce((acc, v) => acc + (v - observedMean) ** 2, 0) / (values.length - 1);
  const expectedVariance = mu + (mu * mu) / k;

  assert.ok(Math.abs(observedMean - mu) < 0.05, `mean ${observedMean}`);
  assert.ok(
    Math.abs(variance - expectedVariance) < 0.3,
    `variance ${variance}, expected ~${expectedVariance}`,
  );
  assert.ok(variance > 1.8 * observedMean, "must be clearly overdispersed vs Poisson");
});

test("logit and sigmoid round-trip", () => {
  for (const p of [0.01, 0.25, 0.5, 0.61, 0.99]) {
    assert.ok(Math.abs(sigmoid(logit(p)) - p) < 1e-9);
  }
});

test("shrink pulls small samples toward the prior and leaves big ones alone", () => {
  // 10 games of data against a prior worth 45 games: mostly prior.
  const small = shrink(6.0, 4.4, 10, 45);
  assert.ok(small > 4.4 && small < 4.8, `got ${small}`);
  // 1000 games: essentially the observation.
  const large = shrink(6.0, 4.4, 1000, 45);
  assert.ok(large > 5.9, `got ${large}`);
  // No observation at all: exactly the prior.
  assert.equal(shrink(null, 4.4, 100, 45), 4.4);
  assert.equal(shrink(6.0, 4.4, 0, 45), 4.4);
});

test("percentiles interpolate", () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 0.5), 3);
  assert.equal(percentile(values, 1), 5);
  assert.equal(percentile(values, 0.25), 2);
});

test("Brier and log loss reward honest probabilities", () => {
  const outcomes = [true, false, true, false];
  const confidentAndRight = brierScore([0.9, 0.1, 0.9, 0.1], outcomes) as number;
  const clueless = brierScore([0.5, 0.5, 0.5, 0.5], outcomes) as number;
  const confidentAndWrong = brierScore([0.1, 0.9, 0.1, 0.9], outcomes) as number;
  assert.ok(confidentAndRight < clueless);
  assert.ok(clueless < confidentAndWrong);
  assert.ok((logLoss([0.9, 0.1, 0.9, 0.1], outcomes) as number) < (logLoss([0.5, 0.5, 0.5, 0.5], outcomes) as number));
});

test("calibration bins count and average correctly", () => {
  const bins = calibrationBins([0.05, 0.15, 0.15, 0.95], [false, true, false, true], 10);
  assert.equal(bins[0]?.count, 1);
  assert.equal(bins[1]?.count, 2);
  assert.equal(bins[1]?.observedRate, 0.5);
  assert.equal(bins[9]?.count, 1);
  assert.equal(bins[9]?.observedRate, 1);
});

test("Platt scaling recovers a known distortion", () => {
  // Generate outcomes from a *true* probability, then feed the model a
  // systematically overconfident version of it. The fit should push back toward
  // the truth: slope below 1 shrinks overconfident probabilities.
  const rng = createRng("platt");
  const predicted: number[] = [];
  const outcomes: boolean[] = [];
  for (let i = 0; i < 4000; i++) {
    const truth = 0.3 + 0.4 * rng.next();
    const overconfident = sigmoid(1.6 * logit(truth));
    predicted.push(overconfident);
    outcomes.push(rng.next() < truth);
  }
  const fit = fitPlattScaling(predicted, outcomes);
  assert.ok(fit.converged, "fit should converge");
  assert.ok(fit.a < 0.9, `slope should shrink overconfidence, got ${fit.a}`);
  assert.ok(fit.a > 0.3, `slope should not collapse, got ${fit.a}`);
});

test("Platt scaling refuses to fit degenerate data", () => {
  assert.deepEqual(fitPlattScaling([0.6, 0.7], [true, true]), {
    a: 1,
    b: 0,
    converged: false,
  });
  assert.deepEqual(fitPlattScaling([], []), { a: 1, b: 0, converged: false });
});
