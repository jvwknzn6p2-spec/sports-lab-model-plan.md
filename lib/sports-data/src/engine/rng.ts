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
