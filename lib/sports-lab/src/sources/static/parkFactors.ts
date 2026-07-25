/**
 * Ballpark run and home-run factors.
 *
 * IMPORTANT — what these numbers are and are not:
 *   - They are approximate, multi-year (roughly 2022-2025) park factors
 *     expressed as multipliers on expected runs and home runs, 1.00 = neutral,
 *     rounded to two decimals. They come from public park-factor tables.
 *   - They are NOT a live feed. Park factors move when a club changes its
 *     fences (Baltimore 2022, 2024) or a team changes venue. Refresh this table
 *     each season; `parkFactorsReviewedFor` records when it was last checked.
 *   - An unknown venue resolves to neutral 1.00 AND raises a
 *     `park_factor_unknown` issue. It never silently guesses.
 *
 * Aliases matter: MLB renames parks (Guaranteed Rate Field -> Rate Field,
 * Minute Maid Park -> Daikin Park) and relocates clubs (the Rays at
 * Steinbrenner Field, the Athletics at Sutter Health Park). Both the old and
 * new names are listed so a rename does not silently degrade to neutral.
 */

import type { ParkFactor, ParkFactorEntry } from "../../core/types";

export const parkFactorsReviewedFor = "2025 season (rounded multi-year values)";

const SOURCE = `public park-factor tables, ${parkFactorsReviewedFor}`;

function entry(runs: number, homeRuns: number): ParkFactorEntry {
  return { runs, homeRuns, source: SOURCE };
}

/** Keys are normalised venue names — see `normaliseVenueName`. */
const PARK_FACTORS: Record<string, ParkFactorEntry> = {
  // Extreme run environments
  "coors field": entry(1.13, 1.1),
  "great american ball park": entry(1.06, 1.16),
  "fenway park": entry(1.05, 0.98),
  "citizens bank park": entry(1.03, 1.1),
  "globe life field": entry(1.03, 1.02),
  "chase field": entry(1.03, 1.03),
  "wrigley field": entry(1.02, 1.02),
  "nationals park": entry(1.02, 1.02),
  "yankee stadium": entry(1.01, 1.11),
  "angel stadium": entry(1.01, 1.02),
  "rogers centre": entry(1.01, 1.03),
  "american family field": entry(1.01, 1.06),
  "rate field": entry(1.01, 1.06),
  "guaranteed rate field": entry(1.01, 1.06),
  "us cellular field": entry(1.01, 1.06),
  "truist park": entry(1.0, 1.01),
  "kauffman stadium": entry(1.0, 0.92),

  // Pitcher-leaning
  "oriole park at camden yards": entry(0.99, 0.97),
  "target field": entry(0.99, 1.0),
  "progressive field": entry(0.98, 0.98),
  "pnc park": entry(0.98, 0.91),
  "comerica park": entry(0.98, 0.94),
  "minute maid park": entry(0.98, 1.02),
  "daikin park": entry(0.98, 1.02),
  "busch stadium": entry(0.97, 0.92),
  "citi field": entry(0.97, 0.97),
  "dodger stadium": entry(0.97, 1.06),
  "loandepot park": entry(0.96, 0.93),
  "marlins park": entry(0.96, 0.93),
  "petco park": entry(0.95, 0.94),
  "tropicana field": entry(0.95, 0.95),
  "t mobile park": entry(0.94, 0.96),
  "oracle park": entry(0.94, 0.86),
  "oakland coliseum": entry(0.93, 0.89),
  "ringcentral coliseum": entry(0.93, 0.89),

  // Temporary / relocated homes
  "george m steinbrenner field": entry(1.05, 1.12),
  "steinbrenner field": entry(1.05, 1.12),
  "sutter health park": entry(1.06, 1.08),
};

/** Lowercase, strip punctuation and diacritics, collapse whitespace. */
export function normaliseVenueName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const NEUTRAL_PARK_FACTOR: ParkFactorEntry = {
  runs: 1,
  homeRuns: 1,
  source: "neutral fallback (venue not in park-factor table)",
};

/**
 * Look up a venue. Always returns a factor; `matched: false` means we fell back
 * to neutral and the caller must raise a data issue.
 */
export function lookupParkFactor(venueName: string): ParkFactor {
  const key = normaliseVenueName(venueName);
  const found = PARK_FACTORS[key];
  if (found) return { ...found, venueName, matched: true };
  return { ...NEUTRAL_PARK_FACTOR, venueName, matched: false };
}

/** Exposed for tests and for a future "refresh the table" script. */
export function knownVenueCount(): number {
  return Object.keys(PARK_FACTORS).length;
}
