/**
 * Numeric parsing helpers for MLB Stats API values.
 *
 * The API returns most rate stats as *strings* (e.g. `".330"`, `"2.85"`) and
 * uses sentinel values like `"-.--"` or `"-"` for "not available". These
 * helpers normalize that into `number | null` so the rest of the codebase can
 * reason about clean numbers — and so a missing value stays `null` (to be
 * flagged) rather than silently becoming `0`.
 */

/**
 * Parse an MLB stat value into a number, or `null` when it is absent/sentinel.
 *
 * Accepts numbers as-is, strings like `".330"`, `"2.85"`, `"-1.2"`. Returns
 * `null` for `null`/`undefined`/empty strings and non-numeric sentinels
 * (`"-"`, `"-.--"`, `".---"`, `"NaN"`, etc.).
 */
export function parseStatNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Reject sentinels: anything without at least one digit is "not available".
  if (!/\d/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse an MLB "innings pitched" value into decimal innings.
 *
 * Baseball notation encodes partial innings as thirds in the *fractional
 * digit*: `".1"` means one out (⅓) and `".2"` means two outs (⅔) — NOT tenths.
 * So `"120.1"` is 120⅓ innings = 120.333…, and `"120.2"` is 120⅔ = 120.666….
 * Treating it as a plain decimal (the obvious-but-wrong reading) understates
 * workload and corrupts every per-inning rate downstream.
 *
 * Returns `null` for absent/sentinel values. A whole number or `".0"` maps to
 * itself. Any other fractional digit is out-of-spec and falls back to a plain
 * numeric read so we never throw on unexpected upstream data.
 */
export function parseInningsPitched(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || !/\d/.test(trimmed)) return null;

  const match = /^(-?)(\d+)(?:\.(\d))?$/.exec(trimmed);
  if (!match) {
    const fallback = Number(trimmed);
    return Number.isFinite(fallback) ? fallback : null;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2]);
  const outsDigit = match[3];

  if (outsDigit === undefined || outsDigit === "0") {
    return sign * whole;
  }
  if (outsDigit === "1" || outsDigit === "2") {
    return sign * (whole + Number(outsDigit) / 3);
  }
  // Out-of-spec fractional digit (.3–.9): treat as a plain decimal rather than
  // pretend it is thirds.
  return sign * Number(`${match[2]}.${outsDigit}`);
}
