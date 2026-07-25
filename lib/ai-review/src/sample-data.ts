/**
 * Sample slate used by the demo and tests. These stand in for the output of
 * Steps 4–7 until those stages are built, and exercise the review layer's main
 * cases: a clean high-confidence pick, a pick with a data gap, and an
 * over-confident pick the Risk Reviewer should catch.
 */

import type { GamePrediction } from "./types.js";

/** A fixed reference time so staleness checks in the demo are deterministic. */
export const SAMPLE_NOW = new Date("2026-07-25T18:00:00Z");

/** Clean, well-supported pick — should survive review at its original rank. */
export const CLEAN_PREDICTION: GamePrediction = {
  gameId: "2026-07-25-LAA-HOU",
  startTimeLocal: "7:10 PM",
  home: { abbreviation: "HOU", name: "Astros" },
  away: { abbreviation: "LAA", name: "Angels" },
  data: {
    scheduleConfirmed: true,
    homePitcher: {
      name: "Framber Valdez",
      confirmed: true,
      era: 2.9,
      whip: 1.05,
      kPer9: 9.4,
      inningsPitched: 130,
    },
    awayPitcher: {
      name: "Reid Detmers",
      confirmed: true,
      era: 4.3,
      whip: 1.31,
      kPer9: 8.7,
      inningsPitched: 110,
    },
    battingStatsAvailable: true,
    bullpenStatsAvailable: true,
    recentFormAvailable: true,
    injuries: [],
    weather: { tempF: 88, windMph: 12, windDir: "out", precipitationChance: 0.05 },
    parkFactorsAvailable: true,
    oddsAvailable: true,
    fetchedAt: "2026-07-25T16:30:00Z",
    staleAfterMinutes: 240,
  },
  model: {
    moneyline: { homeWinProb: 0.61, awayWinProb: 0.39 },
    runLine: { favoriteCoversProb: 0.44, underdogCoversProb: 0.56 },
    total: { predictedTotal: 8.7, line: 8.5, overProb: 0.54, underProb: 0.46 },
    ev: {
      bets: [
        {
          market: "moneyline",
          selection: "HOU ML",
          edge: 0.062,
          evPer1Unit: 0.11,
          positive: true,
        },
      ],
    },
    componentAgreement: 0.82,
    marketEdge: 0.062,
  },
  confidence: "A",
  keyFactors: [
    "Astros strong starter (2.9 ERA)",
    "wind blowing out 12mph",
  ],
};

/** Unconfirmed starter — Data Auditor should force this to C. */
export const DATA_GAP_PREDICTION: GamePrediction = {
  gameId: "2026-07-25-NYY-BOS",
  startTimeLocal: "1:05 PM",
  home: { abbreviation: "BOS", name: "Red Sox" },
  away: { abbreviation: "NYY", name: "Yankees" },
  data: {
    scheduleConfirmed: true,
    homePitcher: {
      name: "Brayan Bello",
      confirmed: false, // projected, not confirmed
      era: 3.8,
      whip: 1.25,
      kPer9: 8.1,
      inningsPitched: 95,
    },
    awayPitcher: {
      name: "Carlos Rodón",
      confirmed: true,
      era: 3.4,
      whip: 1.18,
      kPer9: 10.2,
      inningsPitched: 120,
    },
    battingStatsAvailable: true,
    bullpenStatsAvailable: false, // missing
    recentFormAvailable: true,
    injuries: [
      {
        player: "Rafael Devers",
        team: "home",
        status: "questionable",
        keyPlayer: true,
      },
    ],
    weather: { tempF: 79, windMph: 6, windDir: "cross", precipitationChance: 0.1 },
    parkFactorsAvailable: true,
    oddsAvailable: true,
    fetchedAt: "2026-07-25T09:00:00Z", // 9h old vs 240m budget → stale
    staleAfterMinutes: 240,
  },
  model: {
    moneyline: { homeWinProb: 0.47, awayWinProb: 0.53 },
    runLine: { favoriteCoversProb: 0.41, underdogCoversProb: 0.59 },
    total: { predictedTotal: 9.1, line: 9.0, overProb: 0.52, underProb: 0.48 },
    ev: {
      bets: [
        {
          market: "moneyline",
          selection: "NYY ML",
          edge: 0.021,
          evPer1Unit: 0.03,
          positive: true,
        },
      ],
    },
    componentAgreement: 0.71,
    marketEdge: 0.021,
  },
  confidence: "B",
};

/** Over-confident pick — thin edge and low agreement at rank S. */
export const OVERCONFIDENT_PREDICTION: GamePrediction = {
  gameId: "2026-07-25-LAD-SF",
  startTimeLocal: "9:15 PM",
  home: { abbreviation: "SF", name: "Giants" },
  away: { abbreviation: "LAD", name: "Dodgers" },
  data: {
    scheduleConfirmed: true,
    homePitcher: {
      name: "Logan Webb",
      confirmed: true,
      era: 3.1,
      whip: 1.12,
      kPer9: 8.9,
      inningsPitched: 140,
    },
    awayPitcher: {
      name: "Tyler Glasnow",
      confirmed: true,
      era: 3.0,
      whip: 1.08,
      kPer9: 11.5,
      inningsPitched: 118,
    },
    battingStatsAvailable: true,
    bullpenStatsAvailable: true,
    recentFormAvailable: true,
    injuries: [],
    weather: { tempF: 62, windMph: 8, windDir: "in", precipitationChance: 0.0 },
    parkFactorsAvailable: true,
    oddsAvailable: true,
    fetchedAt: "2026-07-25T17:15:00Z",
    staleAfterMinutes: 240,
  },
  model: {
    moneyline: { homeWinProb: 0.52, awayWinProb: 0.48 }, // near coin flip
    runLine: { favoriteCoversProb: 0.4, underdogCoversProb: 0.6 },
    total: { predictedTotal: 7.2, line: 7.5, overProb: 0.45, underProb: 0.55 },
    ev: {
      bets: [
        {
          market: "moneyline",
          selection: "SF ML",
          edge: 0.012, // thin
          evPer1Unit: 0.02,
          positive: true,
        },
      ],
    },
    componentAgreement: 0.51, // low — components disagree
    marketEdge: 0.012,
  },
  confidence: "S", // claimed very-high confidence the evidence doesn't earn
};

export const SAMPLE_SLATE: GamePrediction[] = [
  CLEAN_PREDICTION,
  DATA_GAP_PREDICTION,
  OVERCONFIDENT_PREDICTION,
];
