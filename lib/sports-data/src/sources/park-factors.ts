/**
 * Ballpark run factors, keyed by MLB Stats API venue id.
 *
 * 100 = neutral; >100 inflates run scoring, <100 suppresses it. These are
 * multi-year RUN park factors in the FanGraphs/Baseball-Savant style — the
 * single number the run model multiplies expected runs by (park effects on
 * HR vs. BABIP are not separated in v1).
 *
 * REFERENCE CONSTANTS, like the sabermetric "Guts!" table: refresh once per
 * offseason from a published source (Savant "Park Factors", 3-year rolling).
 * Values below reflect the 2022–2024 window. Unknown venues (new parks,
 * temporary homes, international games) return undefined and the pipeline
 * treats them as neutral 100 with an explicit warning — never a silent guess.
 */

export interface ParkFactorEntry {
  readonly venueId: number;
  readonly name: string;
  readonly runFactor: number;
}

const PARKS: readonly ParkFactorEntry[] = [
  { venueId: 19, name: "Coors Field (COL)", runFactor: 112 },
  { venueId: 3, name: "Fenway Park (BOS)", runFactor: 107 },
  { venueId: 2602, name: "Great American Ball Park (CIN)", runFactor: 106 },
  { venueId: 15, name: "Chase Field (AZ)", runFactor: 103 },
  { venueId: 7, name: "Kauffman Stadium (KC)", runFactor: 102 },
  { venueId: 3313, name: "Yankee Stadium (NYY)", runFactor: 102 },
  { venueId: 2681, name: "Citizens Bank Park (PHI)", runFactor: 102 },
  { venueId: 4705, name: "Truist Park (ATL)", runFactor: 101 },
  { venueId: 3309, name: "Nationals Park (WSH)", runFactor: 101 },
  { venueId: 14, name: "Rogers Centre (TOR)", runFactor: 101 },
  { venueId: 4, name: "Rate Field (CWS)", runFactor: 101 },
  { venueId: 32, name: "American Family Field (MIL)", runFactor: 101 },
  { venueId: 17, name: "Wrigley Field (CHC)", runFactor: 100 },
  { venueId: 1, name: "Angel Stadium (LAA)", runFactor: 100 },
  { venueId: 22, name: "Dodger Stadium (LAD)", runFactor: 99 },
  { venueId: 2392, name: "Daikin Park (HOU)", runFactor: 99 },
  { venueId: 3312, name: "Target Field (MIN)", runFactor: 99 },
  { venueId: 5325, name: "Globe Life Field (TEX)", runFactor: 99 },
  { venueId: 2, name: "Oriole Park at Camden Yards (BAL)", runFactor: 98 },
  { venueId: 5, name: "Progressive Field (CLE)", runFactor: 98 },
  { venueId: 2394, name: "Comerica Park (DET)", runFactor: 98 },
  { venueId: 31, name: "PNC Park (PIT)", runFactor: 97 },
  { venueId: 2889, name: "Busch Stadium (STL)", runFactor: 97 },
  { venueId: 4169, name: "loanDepot park (MIA)", runFactor: 97 },
  { venueId: 3289, name: "Citi Field (NYM)", runFactor: 97 },
  { venueId: 12, name: "Tropicana Field (TB)", runFactor: 96 },
  { venueId: 2680, name: "Petco Park (SD)", runFactor: 96 },
  { venueId: 10, name: "Oakland Coliseum (ATH)", runFactor: 96 },
  { venueId: 2395, name: "Oracle Park (SF)", runFactor: 95 },
  { venueId: 680, name: "T-Mobile Park (SEA)", runFactor: 94 },
];

const BY_VENUE_ID: ReadonlyMap<number, ParkFactorEntry> = new Map(
  PARKS.map((p) => [p.venueId, p]),
);

/** Run park factor for a venue, or undefined when the venue is unknown. */
export function getParkFactor(venueId: number | null): number | undefined {
  if (venueId === null) return undefined;
  return BY_VENUE_ID.get(venueId)?.runFactor;
}

/** Full entry (for reports/debugging). */
export function getParkFactorEntry(
  venueId: number | null,
): ParkFactorEntry | undefined {
  if (venueId === null) return undefined;
  return BY_VENUE_ID.get(venueId);
}

export const ALL_PARK_FACTORS: readonly ParkFactorEntry[] = PARKS;
