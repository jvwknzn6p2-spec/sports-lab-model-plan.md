/**
 * Step 5 — Seeded random number generation and sampling distributions.
 *
 * The simulation must be **reproducible**: the same game, the same seed, and
 * the same inputs must produce the same probabilities every time. That is what
 * makes a prediction auditable and lets Step 8 backtest fairly (plan Section 3:
 * "cache daily pulls", "timestamp everything" — reproducibility is the same
 * principle applied to the model). So we never touch `Math.random()`.
 *
 * Sampling chain used for team runs:
 *   Gamma(k, mean/k) → a per-game "how good is the offense today" rate
 *   Poisson(rate)    → the actual runs scored
 * which together form a **negative binomial**. See `simulate.ts` for why a
 * plain Poisson is not good enough.
 */

/** A seeded uniform generator returning values in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG. Chosen over a
 * linear congruential generator because it passes basic randomness tests
 * while staying short enough to audit by eye.
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via the Box–Muller transform. */
export function sampleNormal(rng: Rng): number {
  // Guard against log(0); u is in (0, 1].
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma sample with the given `shape` and `scale`, using the Marsaglia–Tsang
 * method. Shapes below 1 are handled by the standard boost identity.
 */
export function sampleGamma(rng: Rng, shape: number, scale: number): number {
  if (shape <= 0) return 0;

  if (shape < 1) {
    // Boost: Gamma(shape) = Gamma(shape + 1) * U^(1/shape)
    const boosted = sampleGamma(rng, shape + 1, scale);
    return boosted * Math.pow(rng(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  // Rejection sampling; converges in ~1.0-1.3 iterations in practice.
  for (;;) {
    const x = sampleNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;

    const u = rng();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v * scale;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/**
 * Poisson sample by Knuth's method. Fine for the small means we use (a team
 * scores single-digit runs); it is O(lambda) so it is not suited to large means.
 */
export function samplePoisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;

  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/**
 * Negative binomial sample expressed as a Gamma–Poisson mixture.
 *
 * @param mean       Expected value.
 * @param dispersion `k` — lower means more overdispersed. Variance works out
 *                   to `mean + mean² / k`, so as k → ∞ this becomes Poisson.
 */
export function sampleNegativeBinomial(rng: Rng, mean: number, dispersion: number): number {
  if (mean <= 0) return 0;
  if (!Number.isFinite(dispersion) || dispersion <= 0) return samplePoisson(rng, mean);

  const rate = sampleGamma(rng, dispersion, mean / dispersion);
  return samplePoisson(rng, rate);
}
