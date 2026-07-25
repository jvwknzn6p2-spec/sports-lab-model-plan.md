/**
 * Step 6 — Odds conversion and vig removal.
 *
 * Sportsbook prices are not probabilities. Two things stand between them:
 *
 *   1. **Format.** US books quote American odds (−150, +130); the maths is
 *      easier in decimal odds (2.50 = "get 2.50 back per 1 staked").
 *   2. **The vig.** A book's two prices always imply *more* than 100% total
 *      probability — that overround is its margin. Comparing the model against
 *      the raw implied numbers would understate our edge on every single bet,
 *      so the vig has to come out before any comparison is made.
 *
 * Removing the vig proportionally is the simplest defensible method and is
 * what v1.0 uses. It slightly overstates the favourite's true probability
 * relative to more sophisticated methods (Shin, power), which is a known and
 * acceptable v1.0 tradeoff.
 */

/** American odds: ≤ −100 or ≥ +100. */
export type AmericanOdds = number;

/** Thrown when a price is not a valid American odds value. */
export class InvalidOddsError extends RangeError {
  constructor(value: number) {
    super(`Invalid American odds: ${value} (must be <= -100 or >= +100)`);
    this.name = "InvalidOddsError";
  }
}

function assertValidAmerican(odds: number): void {
  if (!Number.isFinite(odds) || Math.abs(odds) < 100) throw new InvalidOddsError(odds);
}

/**
 * American → decimal odds (total return per 1 unit staked, stake included).
 *
 *   +130 → 2.30   (risk 1 to win 1.30)
 *   −150 → 1.667  (risk 1 to win 0.667)
 */
export function americanToDecimal(odds: AmericanOdds): number {
  assertValidAmerican(odds);
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

/**
 * Decimal → American odds.
 *
 * Inverse of {@link americanToDecimal} except at even money: −100 and +100
 * are the same price (decimal 2.0), and this returns the conventional +100.
 */
export function decimalToAmerican(decimal: number): AmericanOdds {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new RangeError(`Decimal odds must be > 1, got ${decimal}`);
  }
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

/**
 * The probability a decimal price implies — **including the book's margin**.
 * Use {@link removeVig} before comparing this to a model probability.
 */
export function impliedProbability(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new RangeError(`Decimal odds must be > 1, got ${decimal}`);
  }
  return 1 / decimal;
}

/**
 * The book's margin on a set of prices. A two-way market pricing both sides at
 * −110 implies 52.4% + 52.4% = 104.8%, i.e. a 4.8% overround.
 *
 * @returns The summed implied probability. 1.0 means no margin.
 */
export function overround(decimalOdds: readonly number[]): number {
  return decimalOdds.reduce((sum, d) => sum + impliedProbability(d), 0);
}

/**
 * Strip the vig from a complete market, returning probabilities that sum to 1.
 *
 * Proportional ("multiplicative") normalisation: each side's implied
 * probability is divided by the overround. The inputs must be every outcome of
 * one market — passing a single side would just return 1.
 */
export function removeVig(decimalOdds: readonly number[]): number[] {
  if (decimalOdds.length === 0) return [];
  const raw = decimalOdds.map(impliedProbability);
  const total = raw.reduce((sum, p) => sum + p, 0);
  if (total <= 0) throw new RangeError("Market has no positive implied probability");
  return raw.map((p) => p / total);
}

/** Convenience: de-vig a two-way market given both American prices. */
export function removeVigAmerican(
  sideA: AmericanOdds,
  sideB: AmericanOdds,
): { a: number; b: number; overround: number } {
  const decA = americanToDecimal(sideA);
  const decB = americanToDecimal(sideB);
  const [a, b] = removeVig([decA, decB]);
  return { a, b, overround: overround([decA, decB]) };
}
