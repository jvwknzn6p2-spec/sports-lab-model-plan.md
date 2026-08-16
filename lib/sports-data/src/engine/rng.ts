/**
 * Deterministic RNG for the Monte Carlo engine.
 *
 * Predictions must be reproducible ("prediction lock"): the same inputs + the
 * same seed always produce the same probabilities. We therefore use a small
 * seeded PRNG (mulberry32) instead of Math.random.
 */

export type Rng = () => number;

/** mulberry32 — fast, decent-quality 32-bit seeded PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a stable numeric seed from a string (FNV-1a). */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Poisson sample via Knuth's algorithm — fine for baseball-sized means
 * (mu < ~15). Used to draw a team's runs in one simulated game.
 */
export function poisson(mu: number, rng: Rng): number {
  const L = Math.exp(-mu);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/**
 * Standard normal via Box–Muller. Draws exactly two uniforms per call — a
 * FIXED consumption pattern, chosen over the faster polar/rejection methods
 * because a rejection loop would make the number of RNG calls depend on the
 * values drawn, and any later reordering of draws would silently change every
 * seeded simulation ("prediction lock" reproducibility).
 */
export function normal(rng: Rng): number {
  // Guard u1 away from 0: log(0) is -Infinity.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma(shape, scale=1) via Marsaglia–Tsang (2000). Rejection-based, so the
 * uniform consumption is NOT fixed per call — callers that need bit-for-bit
 * reproducibility get it from the seed, not from counting draws.
 *
 * shape < 1 uses the standard boost: draw Gamma(shape+1) and multiply by
 * U^(1/shape).
 */
export function gamma(shape: number, rng: Rng): number {
  if (!(shape > 0)) throw new RangeError(`gamma shape must be > 0: ${shape}`);
  if (shape < 1) {
    const u = Math.max(rng(), 1e-12);
    return gamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Negative-binomial sample as a gamma–Poisson mixture: draw a game-day rate
 * lambda ~ Gamma(size, mu/size), then runs ~ Poisson(lambda).
 *
 * Mean is mu; variance is mu + mu²/size. This is the standard model for MLB
 * team runs, which are OVERDISPERSED relative to Poisson (run scoring comes
 * in bursts: innings blow up, bullpens implode). A plain Poisson understates
 * that variance, which understates margin variance, which OVERSTATES the
 * favourite's win probability — the exact overconfidence the settled record
 * showed in the 65%+ probability band.
 */
export function negBinomial(mu: number, size: number, rng: Rng): number {
  if (!Number.isFinite(size)) return poisson(mu, rng); // size → ∞ is Poisson
  const lambda = gamma(size, rng) * (mu / size);
  return poisson(lambda, rng);
}
