/**
 * Numerical helpers: seeded RNG, sampling, and the statistics the loop needs.
 *
 * Everything here is deterministic given a seed. That matters: a prediction we
 * cannot reproduce is a prediction we cannot debug or backtest fairly.
 */

// ---------------------------------------------------------------------------
// Seeded RNG (sfc32 seeded by cyrb128) — fast, well-distributed, reproducible.
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

export function createRng(seed: string): Rng {
  let [a, b, c, d] = cyrb128(seed);
  return {
    next(): number {
      a >>>= 0;
      b >>>= 0;
      c >>>= 0;
      d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    },
  };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Standard normal via Box-Muller. */
export function sampleNormal(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, scale=1) via Marsaglia-Tsang. Shape may be < 1.
 */
export function sampleGamma(rng: Rng, shape: number): number {
  if (shape <= 0) throw new Error(`sampleGamma: shape must be > 0, got ${shape}`);
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    const g = sampleGamma(rng, shape + 1);
    let u = rng.next();
    while (u === 0) u = rng.next();
    return g * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const v = 1 + c * x;
    if (v <= 0) continue;
    const v3 = v * v * v;
    let u = rng.next();
    while (u === 0) u = rng.next();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v3;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v3 + Math.log(v3))) return d * v3;
  }
}

/** Poisson(lambda) via Knuth for small lambda, normal-rounding above 40. */
export function samplePoisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda < 40) {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng.next();
    } while (p > limit);
    return k - 1;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * sampleNormal(rng)));
}

/**
 * Negative binomial with mean `mu` and dispersion `k`, so that
 * variance = mu + mu^2 / k. Sampled as a Gamma-Poisson mixture, which is what
 * makes it overdispersed relative to Poisson — the reason we use it for runs.
 *
 * As k -> infinity this converges to Poisson(mu).
 */
export function sampleNegativeBinomial(rng: Rng, mu: number, k: number): number {
  if (mu <= 0) return 0;
  if (!Number.isFinite(k) || k <= 0) return samplePoisson(rng, mu);
  const lambda = (mu * sampleGamma(rng, k)) / k;
  return samplePoisson(rng, lambda);
}

// ---------------------------------------------------------------------------
// Small numeric utilities
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Linear-interpolated percentile of an unsorted array. `p` in [0, 1]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loValue = sorted[lo] as number;
  if (lo === hi) return loValue;
  const hiValue = sorted[hi] as number;
  return loValue + (hiValue - loValue) * (idx - lo);
}

export const EPS = 1e-9;

export function logit(p: number): number {
  const q = clamp(p, EPS, 1 - EPS);
  return Math.log(q / (1 - q));
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * Shrink an observed rate toward a prior. `n` is the observed sample size and
 * `k` the strength of the prior in the same units ("regression to the mean").
 */
export function shrink(
  observed: number | null,
  prior: number,
  n: number,
  k: number,
): number {
  if (observed === null || !Number.isFinite(observed)) return prior;
  if (n <= 0) return prior;
  const w = n / (n + k);
  return w * observed + (1 - w) * prior;
}

// ---------------------------------------------------------------------------
// Scoring metrics for the analysis step
// ---------------------------------------------------------------------------

/** Mean squared error of probabilistic forecasts. Lower is better. */
export function brierScore(predictions: number[], outcomes: boolean[]): number | null {
  if (predictions.length === 0 || predictions.length !== outcomes.length) return null;
  let sum = 0;
  for (let i = 0; i < predictions.length; i++) {
    const o = outcomes[i] === true ? 1 : 0;
    const d = (predictions[i] as number) - o;
    sum += d * d;
  }
  return sum / predictions.length;
}

export function logLoss(predictions: number[], outcomes: boolean[]): number | null {
  if (predictions.length === 0 || predictions.length !== outcomes.length) return null;
  let sum = 0;
  for (let i = 0; i < predictions.length; i++) {
    const p = clamp(predictions[i] as number, 1e-6, 1 - 1e-6);
    sum += outcomes[i] === true ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / predictions.length;
}

/**
 * Reliability table: are the games we call 60% actually winning ~60%?
 */
export function calibrationBins(
  predictions: number[],
  outcomes: boolean[],
  binCount = 10,
): { lower: number; upper: number; count: number; predictedMean: number; observedRate: number }[] {
  const bins = Array.from({ length: binCount }, (_, i) => ({
    lower: i / binCount,
    upper: (i + 1) / binCount,
    count: 0,
    predictedSum: 0,
    wins: 0,
  }));
  for (let i = 0; i < predictions.length; i++) {
    const p = clamp(predictions[i] as number, 0, 1);
    const idx = Math.min(binCount - 1, Math.floor(p * binCount));
    const bin = bins[idx] as (typeof bins)[number];
    bin.count += 1;
    bin.predictedSum += p;
    if (outcomes[i] === true) bin.wins += 1;
  }
  return bins.map((b) => ({
    lower: b.lower,
    upper: b.upper,
    count: b.count,
    predictedMean: b.count > 0 ? b.predictedSum / b.count : 0,
    observedRate: b.count > 0 ? b.wins / b.count : 0,
  }));
}

/**
 * Fit Platt scaling in logit space: p' = sigmoid(a * logit(p) + b).
 *
 * Two-parameter logistic regression solved by Newton-Raphson on the log-
 * likelihood. Returns the identity transform when the data cannot support a
 * fit (too few games, or a degenerate outcome column).
 */
export function fitPlattScaling(
  predictions: number[],
  outcomes: boolean[],
  maxIterations = 50,
): { a: number; b: number; converged: boolean } {
  const n = predictions.length;
  if (n < 2 || n !== outcomes.length) return { a: 1, b: 0, converged: false };
  const wins = outcomes.filter((o) => o).length;
  if (wins === 0 || wins === n) return { a: 1, b: 0, converged: false };

  const x = predictions.map(logit);
  const y = outcomes.map((o) => (o ? 1 : 0));

  let a = 1;
  let b = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    let g0 = 0; // d/da
    let g1 = 0; // d/db
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (let i = 0; i < n; i++) {
      const xi = x[i] as number;
      const p = sigmoid(a * xi + b);
      const r = p - (y[i] as number);
      const w = Math.max(p * (1 - p), 1e-12);
      g0 += r * xi;
      g1 += r;
      h00 += w * xi * xi;
      h01 += w * xi;
      h11 += w;
    }
    // Ridge term keeps the Hessian invertible on near-separable data.
    const ridge = 1e-6;
    h00 += ridge;
    h11 += ridge;
    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { a, b, converged: false };
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a -= da;
    b -= db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { a: 1, b: 0, converged: false };
    if (Math.abs(da) < 1e-8 && Math.abs(db) < 1e-8) return { a, b, converged: true };
  }
  return { a, b, converged: false };
}
