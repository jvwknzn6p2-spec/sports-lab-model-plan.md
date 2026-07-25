/**
 * Step 3 — Ballpark factors.
 *
 * A small, static seed table of park factors keyed by home-team abbreviation.
 * Values are multipliers around a neutral 1.0 and are approximate, public
 * park-factor figures suitable for v1.0. When a venue is not found we return
 * neutral 1.0 values with `isNeutralFallback: true` so the validation layer
 * can flag it — a missing entry must never silently read as an average park.
 *
 * Replace/refresh this table from a maintained park-factor source as the
 * project matures; the lookup contract stays the same.
 */
import type { BallparkFactors } from "../schemas";

interface SeedFactors {
  runsFactor: number;
  hrFactor: number;
}

/** Home-team abbreviation → park factors. Approximate v1.0 seed values. */
const PARK_FACTORS: Readonly<Record<string, SeedFactors>> = {
  COL: { runsFactor: 1.15, hrFactor: 1.11 }, // Coors Field — extreme hitter park
  BOS: { runsFactor: 1.08, hrFactor: 1.03 }, // Fenway Park
  CIN: { runsFactor: 1.07, hrFactor: 1.16 }, // Great American Ball Park
  TEX: { runsFactor: 1.05, hrFactor: 1.06 }, // Globe Life Field
  BAL: { runsFactor: 1.02, hrFactor: 1.08 }, // Camden Yards
  PHI: { runsFactor: 1.03, hrFactor: 1.07 }, // Citizens Bank Park
  ARI: { runsFactor: 1.03, hrFactor: 1.02 }, // Chase Field
  KC: { runsFactor: 1.02, hrFactor: 0.95 }, // Kauffman Stadium
  CHC: { runsFactor: 1.02, hrFactor: 1.04 }, // Wrigley Field (wind-dependent)
  ATL: { runsFactor: 1.01, hrFactor: 1.03 }, // Truist Park
  MIN: { runsFactor: 1.0, hrFactor: 1.02 }, // Target Field
  WSH: { runsFactor: 1.0, hrFactor: 1.01 }, // Nationals Park
  HOU: { runsFactor: 1.0, hrFactor: 1.03 }, // Daikin Park
  TOR: { runsFactor: 1.0, hrFactor: 1.02 }, // Rogers Centre
  LAA: { runsFactor: 0.99, hrFactor: 1.0 }, // Angel Stadium
  NYY: { runsFactor: 0.99, hrFactor: 1.08 }, // Yankee Stadium (short RF)
  CWS: { runsFactor: 0.99, hrFactor: 1.03 }, // Rate Field
  MIL: { runsFactor: 0.99, hrFactor: 1.03 }, // American Family Field
  STL: { runsFactor: 0.98, hrFactor: 0.94 }, // Busch Stadium
  NYM: { runsFactor: 0.97, hrFactor: 0.95 }, // Citi Field
  LAD: { runsFactor: 0.97, hrFactor: 1.02 }, // Dodger Stadium
  TB: { runsFactor: 0.96, hrFactor: 0.95 }, // Tropicana Field
  SEA: { runsFactor: 0.95, hrFactor: 0.97 }, // T-Mobile Park
  CLE: { runsFactor: 0.96, hrFactor: 0.95 }, // Progressive Field
  DET: { runsFactor: 0.96, hrFactor: 0.92 }, // Comerica Park
  OAK: { runsFactor: 0.95, hrFactor: 0.9 }, // Oakland/Sutter Health Park
  PIT: { runsFactor: 0.95, hrFactor: 0.9 }, // PNC Park
  MIA: { runsFactor: 0.94, hrFactor: 0.88 }, // loanDepot park
  SF: { runsFactor: 0.93, hrFactor: 0.85 }, // Oracle Park
  SD: { runsFactor: 0.94, hrFactor: 0.92 }, // Petco Park
};

const NEUTRAL: SeedFactors = { runsFactor: 1.0, hrFactor: 1.0 };

/**
 * Resolve park factors for a game.
 *
 * @param venueId       Stable venue id from Steps 1–2 (echoed into the result).
 * @param homeAbbrev    Home-team abbreviation used to key the seed table.
 */
export function lookupBallparkFactors(venueId: string, homeAbbrev: string): BallparkFactors {
  const seed = PARK_FACTORS[homeAbbrev.toUpperCase()];
  return {
    venueId,
    runsFactor: (seed ?? NEUTRAL).runsFactor,
    hrFactor: (seed ?? NEUTRAL).hrFactor,
    isNeutralFallback: seed === undefined,
  };
}

/** Number of parks in the seed table (useful for tests / diagnostics). */
export const SEED_PARK_COUNT = Object.keys(PARK_FACTORS).length;
