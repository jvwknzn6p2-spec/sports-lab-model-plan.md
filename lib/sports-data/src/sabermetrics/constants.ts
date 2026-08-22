/**
 * League environment constants ("Guts!") used to turn raw counting stats into
 * park- and era-adjusted rate stats.
 *
 * These are the season-specific linear-weight coefficients and league baselines
 * that FanGraphs publishes annually. They drift year to year with the run
 * environment, so wOBA/FIP must always be computed against the constants of the
 * season the stats come from — never a single hard-coded set.
 *
 * SOURCE OF TRUTH: FanGraphs "Guts!" (https://www.fangraphs.com/guts.aspx).
 * The values below are reference constants for recent seasons. Refresh them
 * from Guts! each offseason; `season` on every returned object records which
 * season's environment was actually applied, so a mismatch is auditable.
 */

export interface LeagueConstants {
  /** Season these constants describe. */
  readonly season: number;
  /** League-average wOBA (the anchor wOBA is scaled around). */
  readonly wOBA: number;
  /** Scale that converts wOBA distance into runs. */
  readonly wOBAScale: number;
  // Linear weights (runs above out) per event, on the wOBA scale.
  readonly wBB: number;
  readonly wHBP: number;
  readonly w1B: number;
  readonly w2B: number;
  readonly w3B: number;
  readonly wHR: number;
  /** Baserunning run values. */
  readonly runSB: number;
  readonly runCS: number;
  /** League runs per plate appearance (the offensive baseline). */
  readonly runsPerPA: number;
  /** Runs per win, for WAR-style conversions. */
  readonly runsPerWin: number;
  /** FIP constant (cFIP): the additive term that puts FIP on the ERA scale. */
  readonly cFIP: number;
  /** League FIP (≈ league ERA); denominator for FIP-. */
  readonly lgFIP: number;
  /** League home-run-per-fly-ball rate, for xFIP's expected HR. */
  readonly hrPerFB: number;
}

/**
 * Reference constants by season. Values are FanGraphs-published where the
 * season is complete; treat the most recent, in-progress season as provisional.
 */
const SEASONS: Record<number, LeagueConstants> = {
  2021: {
    season: 2021,
    wOBA: 0.314,
    wOBAScale: 1.209,
    wBB: 0.692,
    wHBP: 0.722,
    w1B: 0.879,
    w2B: 1.242,
    w3B: 1.568,
    wHR: 2.007,
    runSB: 0.2,
    runCS: -0.405,
    runsPerPA: 0.12,
    runsPerWin: 9.964,
    cFIP: 3.17,
    lgFIP: 4.26,
    hrPerFB: 0.135,
  },
  2022: {
    season: 2022,
    wOBA: 0.31,
    wOBAScale: 1.259,
    wBB: 0.689,
    wHBP: 0.72,
    w1B: 0.884,
    w2B: 1.261,
    w3B: 1.601,
    wHR: 2.072,
    runSB: 0.2,
    runCS: -0.39,
    runsPerPA: 0.114,
    runsPerWin: 9.505,
    cFIP: 3.112,
    lgFIP: 3.97,
    hrPerFB: 0.113,
  },
  2023: {
    season: 2023,
    wOBA: 0.318,
    wOBAScale: 1.204,
    wBB: 0.696,
    wHBP: 0.726,
    w1B: 0.883,
    w2B: 1.244,
    w3B: 1.569,
    wHR: 2.004,
    runSB: 0.2,
    runCS: -0.408,
    runsPerPA: 0.122,
    runsPerWin: 10.038,
    cFIP: 3.257,
    lgFIP: 4.33,
    hrPerFB: 0.126,
  },
  2024: {
    season: 2024,
    wOBA: 0.31,
    wOBAScale: 1.243,
    wBB: 0.69,
    wHBP: 0.721,
    w1B: 0.881,
    w2B: 1.254,
    w3B: 1.588,
    wHR: 2.05,
    runSB: 0.2,
    runCS: -0.399,
    runsPerPA: 0.114,
    runsPerWin: 9.53,
    cFIP: 3.16,
    lgFIP: 4.08,
    hrPerFB: 0.116,
  },
  2025: {
    season: 2025,
    wOBA: 0.312,
    wOBAScale: 1.24,
    wBB: 0.69,
    wHBP: 0.722,
    w1B: 0.882,
    w2B: 1.256,
    w3B: 1.59,
    wHR: 2.05,
    runSB: 0.2,
    runCS: -0.4,
    runsPerPA: 0.116,
    runsPerWin: 9.6,
    cFIP: 3.18,
    lgFIP: 4.12,
    hrPerFB: 0.118,
  },
};

const KNOWN_SEASONS = Object.keys(SEASONS)
  .map(Number)
  .sort((a, b) => a - b);

export const LATEST_SEASON = KNOWN_SEASONS[KNOWN_SEASONS.length - 1]!;

/**
 * Get the league constants for a season. Unknown seasons fall back to the
 * nearest known season (clamped to the known range); the returned object's
 * `season` field always reveals which environment was actually applied, so
 * callers can detect and log a fallback rather than being silently misled.
 */
/**
 * Runtime-registered constants for environments FanGraphs does not publish
 * (NPB constants are derived from npb.jp league totals at fetch time and
 * persisted in the slate bundle; predict re-registers them before
 * assembling). Registered under synthetic season keys (e.g. 1002026 =
 * NPB 2026) so they can never shadow a published MLB season.
 */
const REGISTERED: Record<number, LeagueConstants> = {};

export function registerSeasonConstants(c: LeagueConstants): void {
  if (c.season in SEASONS) {
    throw new Error(
      `Season ${c.season} has published constants — refusing to overwrite`,
    );
  }
  REGISTERED[c.season] = c;
}

export function getLeagueConstants(season: number): LeagueConstants {
  const registered = REGISTERED[season];
  if (registered) return registered;
  const exact = SEASONS[season];
  if (exact) return exact;
  const clamped = Math.max(KNOWN_SEASONS[0]!, Math.min(LATEST_SEASON, season));
  // Nearest known season to the (clamped) request.
  let nearest = KNOWN_SEASONS[0]!;
  for (const s of KNOWN_SEASONS) {
    if (Math.abs(s - clamped) < Math.abs(nearest - clamped)) nearest = s;
  }
  return SEASONS[nearest]!;
}

/** True when we have exact published constants for the season. */
export function hasExactConstants(season: number): boolean {
  return season in SEASONS;
}
