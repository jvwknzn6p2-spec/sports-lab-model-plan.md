/**
 * Seeded pseudo-random number generation.
 *
 * Every simulation must be reproducible: re-running the pipeline for the same
 * game on the same inputs has to produce byte-identical probabilities, or
 * backtesting is measuring simulation noise instead of model skill. So we never
 * touch `Math.random()` — all randomness flows from an explicit seed.
 */

/** Mixes a 32-bit integer into a well-distributed 32-bit integer. */
function splitmix32(state: number): { value: number; next: number } {
  let a = (state + 0x9e3779b9) | 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  t = t ^ (t >>> 15);
  return { value: t >>> 0, next: a };
}

/** FNV-1a. Turns a seed string (e.g. `"2026-07-25:ORIX@CHIB"`) into a 32-bit integer. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * xoshiro128** — small, fast, and statistically solid for Monte Carlo work.
 * Not cryptographically secure, which is fine: we are modelling baseball.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** Cached second variate from the polar method (Gaussians come in pairs). */
  private spareNormal: number | null = null;

  constructor(seed: string | number) {
    let state = typeof seed === "string" ? hashString(seed) : seed | 0;
    const a = splitmix32(state);
    state = a.next;
    const b = splitmix32(state);
    state = b.next;
    const c = splitmix32(state);
    state = c.next;
    const d = splitmix32(state);

    this.s0 = a.value;
    this.s1 = b.value;
    this.s2 = c.value;
    this.s3 = d.value;

    // An all-zero state is a fixed point of xoshiro; nudge it if we land there.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9;
  }

  /** Uniform 32-bit integer. */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);

    return result;
  }

  /** Uniform in `[0, 1)`. */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in `(0, 1)` — for logs and divisions that must not see exactly 0. */
  nextOpen(): number {
    return (this.nextUint32() + 0.5) / 4294967296;
  }

  /** Standard normal via the Marsaglia polar method (no trigonometry). */
  normal(): number {
    if (this.spareNormal !== null) {
      const spare = this.spareNormal;
      this.spareNormal = null;
      return spare;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const scale = Math.sqrt((-2 * Math.log(s)) / s);
    this.spareNormal = v * scale;
    return u * scale;
  }

  /**
   * Gamma variate with the given shape and scale (Marsaglia–Tsang, 2000).
   *
   * Shapes below 1 are handled with the standard boosting trick, so the caller
   * can pass any positive shape.
   */
  gamma(shape: number, scale = 1): number {
    if (!(shape > 0)) throw new RangeError(`gamma shape must be > 0, got ${shape}`);

    if (shape < 1) {
      // Gamma(a) === Gamma(a + 1) * U^(1/a)
      return this.gamma(shape + 1, scale) * Math.pow(this.nextOpen(), 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    for (;;) {
      const x = this.normal();
      const oneCx = 1 + c * x;
      if (oneCx <= 0) continue;
      const v = oneCx * oneCx * oneCx;
      const u = this.nextOpen();
      const x2 = x * x;
      // Cheap squeeze first, exact acceptance test only if it fails.
      if (u < 1 - 0.0331 * x2 * x2) return d * v * scale;
      if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  /**
   * Gamma variate with mean 1 and variance `1 / concentration`.
   *
   * This is the shape we actually want everywhere in the run model: a
   * multiplicative "how did this go today" factor that leaves the expectation
   * untouched and only adds spread. `Infinity` means no randomness at all.
   */
  gammaMeanOne(concentration: number): number {
    if (!Number.isFinite(concentration)) return 1;
    return this.gamma(concentration, 1 / concentration);
  }

  /**
   * Poisson variate.
   *
   * Knuth's product method is exact and fast for the small means we deal with
   * (a baseball team's expected runs sits around 4–5). Above `lambda = 30` it
   * would need ~30 uniforms per draw, so we fall back to a normal
   * approximation with a continuity correction. That branch is defensive only:
   * no plausible run expectation reaches it.
   */
  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0;

    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.next();
      } while (p > limit);
      return k - 1;
    }

    const approx = Math.round(lambda + Math.sqrt(lambda) * this.normal());
    return approx < 0 ? 0 : approx;
  }
}
