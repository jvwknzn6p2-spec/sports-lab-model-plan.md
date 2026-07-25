import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRng,
  sampleGamma,
  sampleNegativeBinomial,
  sampleNormal,
  samplePoisson,
} from "./random";

/** Mean and variance of a sample, for distribution sanity checks. */
function moments(values: readonly number[]): { mean: number; variance: number } {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, variance };
}

function draw(n: number, fn: () => number): number[] {
  return Array.from({ length: n }, fn);
}

test("the same seed reproduces the same sequence", () => {
  const a = draw(50, createRng(42));
  const b = draw(50, createRng(42));
  assert.deepEqual(a, b);
});

test("different seeds produce different sequences", () => {
  const a = draw(50, createRng(1));
  const b = draw(50, createRng(2));
  assert.notDeepEqual(a, b);
});

test("uniform samples stay in [0, 1) and average near 0.5", () => {
  const rng = createRng(7);
  const values = draw(20_000, rng);
  assert.ok(values.every((v) => v >= 0 && v < 1));
  assert.ok(Math.abs(moments(values).mean - 0.5) < 0.01);
});

test("normal samples have mean ~0 and variance ~1", () => {
  const rng = createRng(11);
  const { mean, variance } = moments(draw(20_000, () => sampleNormal(rng)));
  assert.ok(Math.abs(mean) < 0.05, `mean was ${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.05, `variance was ${variance}`);
});

test("gamma samples match their theoretical mean and variance", () => {
  const rng = createRng(13);
  const shape = 4;
  const scale = 1.1;
  const { mean, variance } = moments(draw(20_000, () => sampleGamma(rng, shape, scale)));
  // Gamma(k, θ): mean = kθ, variance = kθ².
  assert.ok(Math.abs(mean - shape * scale) < 0.1, `mean was ${mean}`);
  assert.ok(Math.abs(variance - shape * scale ** 2) < 0.2, `variance was ${variance}`);
});

test("gamma handles shapes below 1 via the boost identity", () => {
  const rng = createRng(17);
  const { mean } = moments(draw(20_000, () => sampleGamma(rng, 0.5, 2)));
  assert.ok(Math.abs(mean - 1) < 0.1, `mean was ${mean}`); // 0.5 × 2
  assert.ok(mean > 0);
});

test("poisson samples are non-negative integers with variance equal to the mean", () => {
  const rng = createRng(19);
  const lambda = 4.4;
  const values = draw(20_000, () => samplePoisson(rng, lambda));
  assert.ok(values.every((v) => Number.isInteger(v) && v >= 0));
  const { mean, variance } = moments(values);
  assert.ok(Math.abs(mean - lambda) < 0.1, `mean was ${mean}`);
  assert.ok(Math.abs(variance - lambda) < 0.2, `variance was ${variance}`);
});

test("negative binomial hits its mean and is overdispersed vs Poisson", () => {
  const rng = createRng(23);
  const mean = 4.4;
  const k = 4;
  const values = draw(40_000, () => sampleNegativeBinomial(rng, mean, k));
  assert.ok(values.every((v) => Number.isInteger(v) && v >= 0));

  const m = moments(values);
  assert.ok(Math.abs(m.mean - mean) < 0.1, `mean was ${m.mean}`);

  // Theoretical variance = mean + mean²/k = 4.4 + 4.84 = 9.24.
  const expectedVariance = mean + mean ** 2 / k;
  assert.ok(Math.abs(m.variance - expectedVariance) < 0.5, `variance was ${m.variance}`);
  // The whole point: more spread than a Poisson, whose variance would be 4.4.
  assert.ok(m.variance > mean * 1.5, "should be clearly overdispersed");
});

test("zero and negative means degenerate to zero", () => {
  const rng = createRng(29);
  assert.equal(sampleNegativeBinomial(rng, 0, 4), 0);
  assert.equal(samplePoisson(rng, 0), 0);
  assert.equal(sampleGamma(rng, 0, 1), 0);
});
