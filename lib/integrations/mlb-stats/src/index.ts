/**
 * `@workspace/mlb-stats` — MLB Stats API client.
 *
 * Build step 1: pull the day's games reliably, validate them, and normalise
 * them into a shape the rest of the pipeline can depend on.
 *
 * ```ts
 * const snapshot = await fetchSchedule("2026-07-25");
 * for (const game of snapshot.games.filter((g) => g.isPredictable)) {
 *   predictGame({ expected: baseline(game), seed: game.seed });
 * }
 * ```
 */

export { apiDateSchema, apiGameSchema, apiScheduleSchema } from "./api-schema.ts";
export type { ApiDate, ApiGame, ApiSchedule } from "./api-schema.ts";
export {
  DEFAULT_BASE_URL,
  MlbApiError,
  requestJson,
  type ClientOptions,
  type MlbApiErrorKind,
} from "./client.ts";
export { normalizeGame, normalizeGameType, normalizeStatus, seedForGame } from "./normalize.ts";
export {
  MLB_SPORT_ID,
  fetchSchedule,
  fetchScheduleRange,
  parseSchedule,
  type FetchScheduleOptions,
} from "./schedule.ts";
export { TEAM_ABBREVIATIONS, teamAbbreviation } from "./teams.ts";
export type {
  DataFlag,
  DoubleHeaderKind,
  GameStatus,
  GameType,
  ProbablePitcher,
  ScheduledGame,
  ScheduleSnapshot,
  TeamSide,
  Venue,
} from "./types.ts";
