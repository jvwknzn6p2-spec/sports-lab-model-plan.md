/**
 * HandiEdge — typed schemas for every stage boundary.
 *
 * Every input and output in the pipeline is validated against one of these Zod
 * schemas, so a malformed fixture (or, later, a live API response) fails loudly
 * at the boundary instead of corrupting a prediction. Types are inferred from
 * the schemas — there is one source of truth per shape.
 */

import { z } from "zod/v4";

// --- Inputs ---------------------------------------------------------------

export const teamSchema = z.object({
  abbreviation: z.string().min(1),
  name: z.string().min(1),
});

export const pitcherSchema = z.object({
  name: z.string(),
  confirmed: z.boolean(),
  era: z.number(),
  whip: z.number(),
  kPer9: z.number(),
  inningsPitched: z.number(),
});

/** One scheduled game (Schedule input). */
export const scheduleGameSchema = z.object({
  gameId: z.string().min(1),
  startTimeLocal: z.string(),
  home: teamSchema,
  away: teamSchema,
  homePitcher: pitcherSchema.nullable(),
  awayPitcher: pitcherSchema.nullable(),
  homeBatRunsPg: z.number(),
  awayBatRunsPg: z.number(),
  homeBullpenEra: z.number(),
  awayBullpenEra: z.number(),
  homeFormL10: z.number(),
  awayFormL10: z.number(),
  parkFactor: z.number(),
  tempF: z.number().nullable(),
  windMph: z.number().nullable(),
  windDir: z.enum(["in", "out", "cross", "calm"]).nullable(),
  battingStatsAvailable: z.boolean(),
  bullpenStatsAvailable: z.boolean(),
  oddsAvailable: z.boolean(),
  fetchedAt: z.string(),
});
export const scheduleSchema = z.object({
  date: z.string(),
  games: z.array(scheduleGameSchema),
});

/** The handicap (run line) offered per game (Handicap input). */
export const handicapSchema = z.object({
  date: z.string(),
  lines: z.array(
    z.object({
      gameId: z.string(),
      /** Favored side and the handicap they must cover, e.g. -1.5. */
      favorite: z.enum(["home", "away"]),
      handicap: z.number(),
    }),
  ),
});

/** Control Tower — the config that steers a run. */
export const controlTowerSchema = z.object({
  runLabel: z.string().default("default"),
  seed: z.number().int().default(42),
  ensembleWeights: z
    .object({ logistic: z.number(), baseline: z.number() })
    .default({ logistic: 0.6, baseline: 0.4 }),
  thresholds: z
    .object({
      /** PASS the winner pick when |P(home) - 0.5| is below this. */
      winPassBand: z.number().default(0.06),
      /** Minimum cover probability to make a handicap play. */
      handicapMinProb: z.number().default(0.55),
      /** Confidence ranks at or below this are treated as PASS-only. */
      passAtOrBelow: z.enum(["S", "A", "B", "C", "none"]).default("C"),
    })
    .default({ winPassBand: 0.06, handicapMinProb: 0.55, passAtOrBelow: "C" }),
  calibration: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  review: z
    .object({ enabled: z.boolean(), provider: z.enum(["auto", "heuristic"]) })
    .default({ enabled: true, provider: "auto" }),
});

// --- Intermediate stage records ------------------------------------------

export const intakeGameSchema = z.object({
  gameId: z.string(),
  startTimeLocal: z.string(),
  home: teamSchema,
  away: teamSchema,
  schedule: scheduleGameSchema,
  handicap: z.object({ favorite: z.enum(["home", "away"]), handicap: z.number() }),
  /** Data-completeness flags used for PASS / review. */
  dataComplete: z.boolean(),
  dataIssues: z.array(z.string()),
});

export const featureRowSchema = z.object({
  gameId: z.string(),
  features: z.record(z.string(), z.number()),
});

export const predictionSchema = z.object({
  gameId: z.string(),
  homeWinProbRaw: z.number(),
  logisticP: z.number(),
  baselineP: z.number(),
  coversProbRaw: z.number(),
  predictedTotal: z.number(),
  componentAgreement: z.number(),
});

export const decisionSchema = z.object({
  gameId: z.string(),
  winner: z.string().nullable(),
  loser: z.string().nullable(),
  handicapPick: z.string().nullable(),
  handicapSide: z.enum(["favorite", "underdog"]).nullable(),
  winProbability: z.number(),
  coverProbability: z.number(),
  provisionalConfidence: z.enum(["S", "A", "B", "C"]),
  play: z.boolean(),
  passReason: z.string().nullable(),
  reasons: z.array(z.string()),
});

export const calibratedDecisionSchema = decisionSchema.extend({
  calibratedHomeWinProb: z.number(),
});

// --- Final per-game output (the MVP deliverable) --------------------------

export const gameOutputSchema = z.object({
  gameId: z.string(),
  matchup: z.string(),
  decision: z.enum(["PLAY", "PASS"]),
  winner: z.string().nullable(),
  loser: z.string().nullable(),
  handicapPick: z.string().nullable(),
  winProbability: z.number(),
  confidence: z.enum(["S", "A", "B", "C"]),
  reasons: z.array(z.string()),
  passReason: z.string().nullable(),
  contentHash: z.string(),
  // Settlement context (kept out of the content hash; needed to grade + recalibrate).
  homeAbbr: z.string(),
  awayAbbr: z.string(),
  homeWinProbHome: z.number(),
  handicapFavorite: z.enum(["home", "away"]),
  handicapLine: z.number(),
  handicapSide: z.enum(["favorite", "underdog"]).nullable(),
});

export const lockedFileSchema = z.object({
  date: z.string(),
  runLabel: z.string(),
  lockedAt: z.string(),
  reviewProvider: z.string(),
  games: z.array(gameOutputSchema),
});

// --- Settlement / analysis / learning ------------------------------------

export const resultsSchema = z.object({
  date: z.string(),
  results: z.array(
    z.object({ gameId: z.string(), homeScore: z.number(), awayScore: z.number() }),
  ),
});

export const settledGameSchema = z.object({
  gameId: z.string(),
  decision: z.enum(["PLAY", "PASS"]),
  confidence: z.enum(["S", "A", "B", "C"]),
  winProbability: z.number(),
  pickedHome: z.boolean().nullable(),
  winnerCorrect: z.boolean().nullable(),
  handicapPick: z.string().nullable(),
  handicapCorrect: z.boolean().nullable(),
  actualHomeWin: z.boolean(),
  homeWinProbForCalibration: z.number(),
});
export const settledFileSchema = z.object({
  date: z.string(),
  runLabel: z.string(),
  settled: z.array(settledGameSchema),
});

export const errorReportSchema = z.object({
  date: z.string(),
  runLabel: z.string(),
  nGames: z.number(),
  nPlays: z.number(),
  passRate: z.number(),
  winnerAccuracy: z.number(),
  handicapAccuracy: z.number(),
  accuracyByConfidence: z.record(z.string(), z.object({ n: z.number(), accuracy: z.number() })),
  brier: z.number(),
  calibrationEce: z.number(),
  overconfidenceSignal: z.number(),
});

export const learningUpdateSchema = z.object({
  date: z.string(),
  prevWeights: z.object({ logistic: z.number(), baseline: z.number() }),
  newWeights: z.object({ logistic: z.number(), baseline: z.number() }),
  recalibrate: z.boolean(),
  rationale: z.array(z.string()),
});

// --- Inferred types -------------------------------------------------------

export type Team = z.infer<typeof teamSchema>;
export type ScheduleGame = z.infer<typeof scheduleGameSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type Handicap = z.infer<typeof handicapSchema>;
export type ControlTower = z.infer<typeof controlTowerSchema>;
export type IntakeGame = z.infer<typeof intakeGameSchema>;
export type FeatureRow = z.infer<typeof featureRowSchema>;
export type Prediction = z.infer<typeof predictionSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type CalibratedDecision = z.infer<typeof calibratedDecisionSchema>;
export type GameOutput = z.infer<typeof gameOutputSchema>;
export type LockedFile = z.infer<typeof lockedFileSchema>;
export type Results = z.infer<typeof resultsSchema>;
export type SettledGame = z.infer<typeof settledGameSchema>;
export type SettledFile = z.infer<typeof settledFileSchema>;
export type ErrorReport = z.infer<typeof errorReportSchema>;
export type LearningUpdate = z.infer<typeof learningUpdateSchema>;
export type Confidence = "S" | "A" | "B" | "C";
