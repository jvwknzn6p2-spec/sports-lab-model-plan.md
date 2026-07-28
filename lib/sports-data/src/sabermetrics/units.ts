/**
 * Baseball counting-stat units, with correct handling of "innings pitched".
 *
 * MLB reports innings pitched in a base-3 fractional notation where the digit
 * after the decimal point is a number of outs, NOT a true decimal fraction:
 *   "180.0" = 180 innings         (540 outs)
 *   "180.1" = 180 innings + 1 out (541 outs)
 *   "180.2" = 180 innings + 2 out (542 outs)
 * There is deliberately no ".3" — three outs roll over to the next full inning.
 *
 * Every rate-stat denominator in this library is derived from OUTS, so that
 * "180.1" is treated as 180⅓ and never as 180.1 (a ~0.03 IP error that
 * silently corrupts ERA/FIP/K9 if the raw string is used as a float).
 */

const OUTS_PER_INNING = 3;

/** Thrown when an innings-pitched value cannot be interpreted safely. */
export class InningsParseError extends Error {
  constructor(input: unknown) {
    super(`Invalid innings-pitched value: ${JSON.stringify(input)}`);
    this.name = "InningsParseError";
  }
}

/**
 * Convert an MLB innings-pitched value into a whole number of outs.
 * Accepts the API string form ("180.1"), a already-thirds number, or a plain
 * integer count of innings. Fails loudly on anything ambiguous.
 */
export function inningsToOuts(ip: string | number): number {
  if (typeof ip === "number") {
    if (!Number.isFinite(ip) || ip < 0) throw new InningsParseError(ip);
    // A JS number carrying the ".1"/".2" outs convention (e.g. 180.1).
    const whole = Math.trunc(ip);
    const frac = Math.round((ip - whole) * 10);
    if (frac !== 0 && frac !== 1 && frac !== 2) {
      // Not the outs convention — treat as a true decimal innings value.
      return Math.round(ip * OUTS_PER_INNING);
    }
    return whole * OUTS_PER_INNING + frac;
  }

  const trimmed = ip.trim();
  if (trimmed === "") throw new InningsParseError(ip);
  const match = /^(\d+)(?:\.(\d))?$/.exec(trimmed);
  if (!match) throw new InningsParseError(ip);
  const whole = Number(match[1]);
  const outsDigit = match[2] === undefined ? 0 : Number(match[2]);
  if (outsDigit > 2) throw new InningsParseError(ip);
  return whole * OUTS_PER_INNING + outsDigit;
}

/** Convert a whole number of outs back to decimal innings (180⅓ -> 180.333…). */
export function outsToInnings(outs: number): number {
  return outs / OUTS_PER_INNING;
}

/** Convert an innings-pitched value to decimal innings (180.1 -> 180.333…). */
export function inningsToDecimal(ip: string | number): number {
  return outsToInnings(inningsToOuts(ip));
}

/** Render outs in MLB "180.1" notation (for reports/round-trips). */
export function outsToNotation(outs: number): string {
  const whole = Math.trunc(outs / OUTS_PER_INNING);
  const rem = outs % OUTS_PER_INNING;
  return `${whole}.${rem}`;
}

/**
 * Safe rate: returns `null` when the denominator is zero rather than NaN/±∞.
 * Keeping "no data" distinct from "0.0" is a core data principle of this
 * project — we never fabricate a number out of an empty sample.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Round to a fixed number of decimals (default 3), preserving null. */
export function round(value: number | null, decimals = 3): number | null {
  if (value === null) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
