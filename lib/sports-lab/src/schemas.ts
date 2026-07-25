/**
 * Step 3 — Context data schemas.
 *
 * Runtime schemas (zod) + inferred types for the context-data layer of the
 * AI Sports Lab pipeline: recent form, injuries, weather, and ballpark
 * factors. These describe the *normalized* shape of each context source
 * after ingestion — validation and flagging (see `validate.ts`) operate on
 * these types.
 *
 * Design principles taken from the model plan (Section 3):
 *   - Fail loudly, not silently: every field that can be missing is nullable
 *     so the validation layer can flag it rather than a fake number hiding it.
 *   - Timestamp everything: each source carries a `fetchedAt` ISO timestamp.
 *   - Weather is observed-vs-forecast sensitive: `weatherMode` is a first-class
 *     field so downstream code never confuses a forecast for a live reading.
 */
import { z } from "zod";

/** ISO-8601 timestamp string, e.g. "2026-07-25T18:10:00Z". */
export const isoTimestamp = z
  .string()
  .datetime({ offset: true })
  .describe("ISO-8601 timestamp with timezone offset");

/** Confidence ranks from the plan, best → worst. */
export const confidenceRankSchema = z.enum(["S", "A", "B", "C"]);
export type ConfidenceRank = z.infer<typeof confidenceRankSchema>;

/** Home / away designation used throughout the context layer. */
export const sideSchema = z.enum(["home", "away"]);
export type Side = z.infer<typeof sideSchema>;

/* -------------------------------------------------------------------------- */
/* Step 1 / Step 2 input contract (schedule + core game data)                 */
/* -------------------------------------------------------------------------- */
/*
 * Step 3 consumes the output of Steps 1–2. Those steps are not built yet, so
 * we pin the *contract* Step 3 depends on here. Only the fields the context
 * and validation layers actually read are modeled; Steps 1–2 may carry more.
 */

export const teamRefSchema = z.object({
  /** Stable team id (e.g. MLB Stats API team id or abbreviation). */
  id: z.string().min(1),
  /** Human-readable name, e.g. "Houston Astros". */
  name: z.string().min(1),
  /** 2–3 letter abbreviation, e.g. "HOU". Used to look up park factors. */
  abbreviation: z.string().min(2).max(4),
});
export type TeamRef = z.infer<typeof teamRefSchema>;

export const startingPitcherSchema = z.object({
  playerId: z.string().min(1),
  name: z.string().min(1),
  /** Whether the club has officially confirmed this starter. */
  confirmed: z.boolean(),
  seasonEra: z.number().nonnegative().nullable(),
  seasonWhip: z.number().nonnegative().nullable(),
  inningsPitched: z.number().nonnegative().nullable(),
});
export type StartingPitcher = z.infer<typeof startingPitcherSchema>;

/**
 * Season-to-date team batting. `runsPerGame` is the offense anchor the
 * baseline model scales from, so it is the one field the model cannot
 * substitute for; the rate stats are carried for later refinement.
 */
export const teamBattingStatsSchema = z.object({
  teamId: z.string().min(1),
  runsPerGame: z.number().nonnegative().nullable(),
  onBasePct: z.number().min(0).max(1).nullable(),
  sluggingPct: z.number().nonnegative().nullable(),
  wOBA: z.number().nonnegative().nullable(),
  fetchedAt: isoTimestamp,
});
export type TeamBattingStats = z.infer<typeof teamBattingStatsSchema>;

/**
 * Bullpen quality plus recent workload. `inningsPitchedLast3Days` is the
 * fatigue signal — a bullpen that just threw heavy innings allows more runs.
 */
export const bullpenStatsSchema = z.object({
  teamId: z.string().min(1),
  era: z.number().nonnegative().nullable(),
  inningsPitchedLast3Days: z.number().nonnegative().nullable(),
  fetchedAt: isoTimestamp,
});
export type BullpenStats = z.infer<typeof bullpenStatsSchema>;

/** The per-game payload Steps 1–2 hand to Steps 3–4. */
export const coreGameSchema = z.object({
  /** Stable per-game id (MLB Stats API gamePk or similar). */
  gameId: z.string().min(1),
  /** Scheduled first-pitch time. */
  startTime: isoTimestamp,
  /** Venue id/name used to resolve ballpark factors. */
  venueId: z.string().min(1),
  venueName: z.string().min(1),
  home: teamRefSchema,
  away: teamRefSchema,
  /** null when a source failed or a starter is not yet named. */
  homeStarter: startingPitcherSchema.nullable(),
  awayStarter: startingPitcherSchema.nullable(),
  /** Step 2 team batting; null when the source failed. */
  homeBatting: teamBattingStatsSchema.nullable(),
  awayBatting: teamBattingStatsSchema.nullable(),
  /** Step 2 bullpen stats; null when the source failed. */
  homeBullpen: bullpenStatsSchema.nullable(),
  awayBullpen: bullpenStatsSchema.nullable(),
});
export type CoreGame = z.infer<typeof coreGameSchema>;

/* -------------------------------------------------------------------------- */
/* Context source: recent form                                                */
/* -------------------------------------------------------------------------- */

/** One prior game's result from a team's perspective. */
export const gameResultSchema = z.object({
  date: isoTimestamp,
  won: z.boolean(),
  runsScored: z.number().int().nonnegative(),
  runsAllowed: z.number().int().nonnegative(),
});
export type GameResult = z.infer<typeof gameResultSchema>;

/**
 * Recent form for a single team, derived from the last N completed games.
 * `sampleSize` may be smaller than requested early in the season — the
 * validation layer flags small samples (plan Section 7: form is noisy).
 */
export const teamRecentFormSchema = z.object({
  teamId: z.string().min(1),
  /** Number of completed games actually available (0..window). */
  sampleSize: z.number().int().nonnegative(),
  /** The window requested, e.g. 10 or 15. */
  window: z.number().int().positive(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  runsScoredPerGame: z.number().nonnegative().nullable(),
  runsAllowedPerGame: z.number().nonnegative().nullable(),
  fetchedAt: isoTimestamp,
});
export type TeamRecentForm = z.infer<typeof teamRecentFormSchema>;

/* -------------------------------------------------------------------------- */
/* Context source: injuries                                                    */
/* -------------------------------------------------------------------------- */

export const injuryStatusSchema = z.enum([
  "out", // ruled out / on the IL
  "day-to-day", // questionable / game-time decision
  "probable", // expected to play
]);
export type InjuryStatus = z.infer<typeof injuryStatusSchema>;

/** Whether the injured player materially changes team strength. */
export const injuryImpactSchema = z.enum(["key-hitter", "starter", "bullpen", "bench"]);
export type InjuryImpact = z.infer<typeof injuryImpactSchema>;

export const injurySchema = z.object({
  playerId: z.string().min(1),
  name: z.string().min(1),
  status: injuryStatusSchema,
  impact: injuryImpactSchema,
  note: z.string().nullable(),
});
export type Injury = z.infer<typeof injurySchema>;

export const teamInjuryReportSchema = z.object({
  teamId: z.string().min(1),
  injuries: z.array(injurySchema),
  /**
   * True when the club has posted its official lineup. Until then, injury
   * impact on the lineup is provisional and the validation layer warns.
   */
  lineupConfirmed: z.boolean(),
  fetchedAt: isoTimestamp,
});
export type TeamInjuryReport = z.infer<typeof teamInjuryReportSchema>;

/* -------------------------------------------------------------------------- */
/* Context source: weather                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The observed-vs-forecast distinction the plan flags as real. A model run
 * hours before first pitch only has a *forecast*; a run near/after first pitch
 * may have an *observed* reading. Never let the two be confused downstream.
 */
export const weatherModeSchema = z.enum(["observed", "forecast"]);
export type WeatherMode = z.infer<typeof weatherModeSchema>;

/** Wind direction relative to the field, which is what affects run scoring. */
export const windRelativeSchema = z.enum([
  "out", // blowing out to the outfield → boosts runs/HR
  "in", // blowing in from the outfield → suppresses runs/HR
  "cross", // crosswind → mostly neutral
  "calm", // negligible wind
]);
export type WindRelative = z.infer<typeof windRelativeSchema>;

/** Whether the venue's roof takes weather out of play. */
export const roofStateSchema = z.enum(["open", "closed", "none"]);
export type RoofState = z.infer<typeof roofStateSchema>;

export const weatherSchema = z.object({
  /** CRITICAL: whether these numbers are a live reading or a forecast. */
  weatherMode: weatherModeSchema,
  /** For forecasts, the time the forecast targets (should ~ first pitch). */
  forecastFor: isoTimestamp.nullable(),
  temperatureF: z.number().nullable(),
  windSpeedMph: z.number().nonnegative().nullable(),
  windRelative: windRelativeSchema.nullable(),
  /** Probability of precipitation, 0..1. */
  precipitationChance: z.number().min(0).max(1).nullable(),
  roofState: roofStateSchema,
  fetchedAt: isoTimestamp,
});
export type Weather = z.infer<typeof weatherSchema>;

/* -------------------------------------------------------------------------- */
/* Context source: ballpark factors                                            */
/* -------------------------------------------------------------------------- */

/**
 * Park factors are multipliers around a neutral 1.0. > 1.0 boosts the metric,
 * < 1.0 suppresses it. `isNeutralFallback` is true when the venue was not
 * found and neutral 1.0 values were substituted — the validation layer flags
 * this so a missing table entry never silently reads as an average park.
 */
export const ballparkFactorsSchema = z.object({
  venueId: z.string().min(1),
  runsFactor: z.number().positive(),
  hrFactor: z.number().positive(),
  isNeutralFallback: z.boolean(),
});
export type BallparkFactors = z.infer<typeof ballparkFactorsSchema>;

/* -------------------------------------------------------------------------- */
/* Assembled per-game context                                                  */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Betting odds (Step 6)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * American odds, the US sportsbook convention: −150 means risk 150 to win 100,
 * +130 means risk 100 to win 130. Values strictly between −100 and +100 are
 * not valid odds.
 */
export const americanOddsSchema = z
  .number()
  .refine((v) => Math.abs(v) >= 100, {
    message: "American odds must be <= -100 or >= +100",
  })
  .describe("American (moneyline-style) odds");

export const moneylineOddsSchema = z.object({
  home: americanOddsSchema,
  away: americanOddsSchema,
});
export type MoneylineOdds = z.infer<typeof moneylineOddsSchema>;

/**
 * Run-line market. `line` is the spread laid by the home team, so the standard
 * MLB market is `line: 1.5` — home −1.5 at `homePrice`, away +1.5 at `awayPrice`.
 */
export const runLineOddsSchema = z.object({
  line: z.number().positive(),
  homePrice: americanOddsSchema,
  awayPrice: americanOddsSchema,
});
export type RunLineOdds = z.infer<typeof runLineOddsSchema>;

export const totalOddsSchema = z.object({
  line: z.number().positive(),
  overPrice: americanOddsSchema,
  underPrice: americanOddsSchema,
});
export type TotalOdds = z.infer<typeof totalOddsSchema>;

/**
 * A sportsbook's posted markets for one game. Each market is independently
 * nullable — a book may not have posted a total yet, and a missing market
 * means "no bet here", not a broken game.
 */
export const gameOddsSchema = z.object({
  gameId: z.string().min(1),
  /** Which book these came from, recorded for auditing. */
  sportsbook: z.string().min(1),
  moneyline: moneylineOddsSchema.nullable(),
  runLine: runLineOddsSchema.nullable(),
  total: totalOddsSchema.nullable(),
  /** Odds move — this timestamp is what makes an EV figure interpretable. */
  fetchedAt: isoTimestamp,
});
export type GameOdds = z.infer<typeof gameOddsSchema>;

export const gameContextSchema = z.object({
  gameId: z.string().min(1),
  recentForm: z.object({ home: teamRecentFormSchema, away: teamRecentFormSchema }),
  injuries: z.object({ home: teamInjuryReportSchema, away: teamInjuryReportSchema }),
  weather: weatherSchema,
  ballpark: ballparkFactorsSchema,
});
export type GameContext = z.infer<typeof gameContextSchema>;
