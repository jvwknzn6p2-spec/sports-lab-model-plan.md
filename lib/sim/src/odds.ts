/**
 * Odds conversion, margin removal, and expected value.
 *
 * ## Why de-vigging is not optional
 *
 * A sportsbook's quoted prices do not sum to 100%. A two-way market priced at
 * 1.91 / 1.91 implies 52.4% + 52.4% = 104.8%; that extra 4.8% is the book's
 * margin (the overround, or 控除率 / hold). Comparing a model probability
 * directly against a quoted price therefore measures the model's edge *plus*
 * the book's margin, which is not an edge you can collect.
 *
 * The honest comparison is against the *de-vigged* market probability — what
 * the market actually believes once its own cut is stripped out. A model that
 * only beats the raw price is a model that loses money at scale. Every
 * function here exists so the pipeline can state, and check, the stronger
 * claim: positive expected value *after* the margin.
 *
 * Four removal methods are provided because they disagree, and the
 * disagreement is largest exactly where it matters — on longshots. Multiplicative
 * is the common default; Shin and power are better behaved on lopsided markets
 * where the favourite-longshot bias is strongest.
 */

/** Decimal odds → implied probability, margin included. */
export function decimalToProbability(decimal: number): number {
  if (!(decimal > 1)) throw new RangeError(`decimal odds must be > 1, got ${decimal}`);
  return 1 / decimal;
}

/** Probability → break-even decimal odds. */
export function probabilityToDecimal(probability: number): number {
  if (!(probability > 0) || probability > 1) {
    throw new RangeError(`probability must be in (0, 1], got ${probability}`);
  }
  return 1 / probability;
}

/** American odds → decimal odds. */
export function americanToDecimal(american: number): number {
  if (american === 0) throw new RangeError("American odds cannot be 0");
  return american > 0 ? american / 100 + 1 : 100 / -american + 1;
}

/** Decimal odds → American odds. Returns `Infinity` for an unbeatable selection. */
export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal)) return Infinity;
  if (decimal <= 1) return -Infinity;
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

/**
 * Sum of implied probabilities across a market. `1.048` means a 4.8% overround.
 */
export function overround(decimalOdds: readonly number[]): number {
  if (decimalOdds.length === 0) throw new RangeError("need at least one price");
  return decimalOdds.reduce((sum, odds) => sum + decimalToProbability(odds), 0);
}

/**
 * The bookmaker's margin as a share of stakes — the 控除率 / hold.
 *
 * This is the number to hold a strategy against: a 1.91/1.91 market has a 4.8%
 * overround but a 4.6% hold, and it is the hold that has to be cleared before
 * a long-run edge is real.
 */
export function bookmakerMargin(decimalOdds: readonly number[]): number {
  const total = overround(decimalOdds);
  return (total - 1) / total;
}

export type DevigMethod = "multiplicative" | "additive" | "power" | "shin";

function normalise(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

/** Scales every implied probability by the same factor. Simple, and the usual default. */
function devigMultiplicative(quoted: number[]): number[] {
  return normalise(quoted);
}

/**
 * Subtracts the margin equally in probability terms.
 *
 * Takes more off longshots in relative terms than multiplicative does. Can push
 * a very long price below zero, in which case we floor it and renormalise.
 */
function devigAdditive(quoted: number[]): number[] {
  const excess = quoted.reduce((sum, value) => sum + value, 0) - 1;
  const share = excess / quoted.length;
  return normalise(quoted.map((value) => Math.max(value - share, 1e-6)));
}

/** Bisection for a monotone decreasing function on `[lo, hi]`. */
function solve(f: (x: number) => number, lo: number, hi: number, iterations = 200): number {
  let low = lo;
  let high = hi;
  for (let i = 0; i < iterations; i++) {
    const mid = (low + high) / 2;
    if (f(mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Raises every implied probability to a common power `k` chosen so they sum to 1.
 *
 * Because `q < 1`, a larger `k` shrinks longshots faster than favourites, which
 * matches the observed favourite-longshot bias better than a flat scaling.
 */
function devigPower(quoted: number[]): number[] {
  if (quoted.some((value) => value >= 1)) return devigMultiplicative(quoted);
  const k = solve((exponent) => quoted.reduce((s, q) => s + Math.pow(q, exponent), 0) - 1, 1, 100);
  return normalise(quoted.map((q) => Math.pow(q, k)));
}

/**
 * Shin's model: treats the margin as the book's protection against insider
 * money, and backs out the probability an uninformed bettor faces.
 *
 * `z` is the implied share of informed money, solved so the fair probabilities
 * sum to 1. Typical real-world values are 1–5%.
 */
function devigShin(quoted: number[]): number[] {
  const total = quoted.reduce((sum, value) => sum + value, 0);
  if (total <= 1) return normalise(quoted);

  const probability = (z: number, q: number): number =>
    (Math.sqrt(z * z + (4 * (1 - z) * q * q) / total) - z) / (2 * (1 - z));

  const z = solve((candidate) => quoted.reduce((s, q) => s + probability(candidate, q), 0) - 1, 0, 0.99);
  return normalise(quoted.map((q) => probability(z, q)));
}

/**
 * Strip the bookmaker's margin from a complete set of prices for one market.
 *
 * Pass every outcome of the market together (both sides of a moneyline, both
 * sides of a total) — the margin can only be identified from the full set.
 */
export function removeVig(
  decimalOdds: readonly number[],
  method: DevigMethod = "multiplicative",
): number[] {
  const quoted = decimalOdds.map(decimalToProbability);
  switch (method) {
    case "multiplicative":
      return devigMultiplicative(quoted);
    case "additive":
      return devigAdditive(quoted);
    case "power":
      return devigPower(quoted);
    case "shin":
      return devigShin(quoted);
  }
}

/**
 * Expected profit per unit staked.
 *
 * A pushed bet returns the stake, so it contributes nothing either way —
 * hence subtracting only the genuine loss probability.
 */
export function expectedValue(
  modelProbability: number,
  decimalOdds: number,
  pushProbability = 0,
): number {
  const loss = Math.max(0, 1 - modelProbability - pushProbability);
  return modelProbability * (decimalOdds - 1) - loss;
}

/**
 * Kelly stake as a fraction of bankroll.
 *
 * Full Kelly is famously too aggressive for a model whose probabilities are
 * themselves estimates — a 10% overestimate of the edge produces heavy
 * drawdowns. Scale it down (quarter Kelly is a common choice) before it ever
 * reaches a staking recommendation.
 */
export function kellyFraction(modelProbability: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  return Math.max(0, (modelProbability * decimalOdds - 1) / b);
}

export interface ValueAssessment {
  /** The model's probability for this selection. */
  modelProbability: number;
  /** What the market believes, once its margin is removed. */
  marketProbability: number;
  /** Model minus market, in probability points. This is the real edge. */
  edge: number;
  /** Expected profit per unit staked at the quoted price. */
  expectedValue: number;
  /** The book's margin on this market. */
  margin: number;
  /** Break-even price for the model's probability. */
  fairDecimal: number;
  /** Unscaled Kelly fraction — scale down before use. */
  kelly: number;
}

/**
 * Compare a model probability against a real quoted market.
 *
 * Requires the prices for *every* outcome so the margin can be removed, and
 * `selectionIndex` to say which of them is being assessed. The returned `edge`
 * is measured against the de-vigged market, so a positive number is an edge
 * that survives the 控除率 — not one that merely looks good against the
 * marked-up price.
 */
export function assessValue(
  modelProbability: number,
  marketDecimalOdds: readonly number[],
  selectionIndex: number,
  method: DevigMethod = "multiplicative",
): ValueAssessment {
  if (selectionIndex < 0 || selectionIndex >= marketDecimalOdds.length) {
    throw new RangeError(`selectionIndex ${selectionIndex} out of range`);
  }
  const fair = removeVig(marketDecimalOdds, method);
  const quoted = marketDecimalOdds[selectionIndex];
  return {
    modelProbability,
    marketProbability: fair[selectionIndex],
    edge: modelProbability - fair[selectionIndex],
    expectedValue: expectedValue(modelProbability, quoted),
    margin: bookmakerMargin(marketDecimalOdds),
    fairDecimal: probabilityToDecimal(modelProbability),
    kelly: kellyFraction(modelProbability, quoted),
  };
}
