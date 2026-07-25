/**
 * Zod schemas for the raw MLB Stats API response.
 *
 * These mirror the wire format exactly — normalisation into our own domain
 * model happens in `normalize.ts`. Keeping the two apart means an upstream
 * field rename shows up here as a clear validation error rather than as a
 * mysterious `undefined` three layers down.
 *
 * Zod objects strip unknown keys rather than rejecting them, which is what we
 * want: MLB adds fields to this payload regularly and none of those additions
 * should break a morning run. Fields we actually depend on are required, so a
 * *removal* fails loudly (model-plan.md §3, "fail loudly, not silently").
 *
 * Endpoint: `GET https://statsapi.mlb.com/api/v1/schedule`
 */

import { z } from "zod/v4";

/** `{ id, name, link }` — the shape the API uses for every cross-reference. */
const referenceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

const leagueRecordSchema = z.object({
  wins: z.number().int(),
  losses: z.number().int(),
  pct: z.string().optional(),
});

/** Present only when the request hydrates `probablePitcher`, and only once announced. */
const probablePitcherSchema = z.object({
  id: z.number().int(),
  fullName: z.string(),
});

const teamSideSchema = z.object({
  team: referenceSchema,
  leagueRecord: leagueRecordSchema.optional(),
  probablePitcher: probablePitcherSchema.optional(),
  /** Present once the game has started. */
  score: z.number().int().optional(),
  isWinner: z.boolean().optional(),
  splitSquad: z.boolean().optional(),
  seriesNumber: z.number().int().optional(),
});

/**
 * Game state, reported three different ways.
 *
 * `abstractGameState` is the coarse bucket (Preview / Live / Final),
 * `codedGameState` a single letter, `detailedState` the human string. We read
 * `detailedState` for the cases that actually change our behaviour
 * (postponed, cancelled, suspended) because it is the most explicit, and fall
 * back to `abstractGameState` for the rest.
 */
const statusSchema = z.object({
  abstractGameState: z.string(),
  codedGameState: z.string(),
  detailedState: z.string(),
  statusCode: z.string().optional(),
  startTimeTBD: z.boolean().optional(),
  reason: z.string().optional(),
});

export const apiGameSchema = z.object({
  /** Globally unique game id. Stable across re-fetches and unique per game of a doubleheader. */
  gamePk: z.number().int(),
  gameType: z.string(),
  season: z.string(),
  /** Scheduled first pitch, UTC. */
  gameDate: z.string(),
  /** Calendar date the game officially belongs to, `YYYY-MM-DD`. */
  officialDate: z.string().optional(),
  status: statusSchema,
  teams: z.object({
    home: teamSideSchema,
    away: teamSideSchema,
  }),
  venue: referenceSchema.optional(),
  /** `"N"` none, `"Y"` traditional (one admission), `"S"` split (two admissions). */
  doubleHeader: z.string().optional(),
  /** 1 or 2 within a doubleheader; 1 otherwise. */
  gameNumber: z.number().int().optional(),
  /** 9 normally; 7 for some doubleheader and shortened formats. */
  scheduledInnings: z.number().int().optional(),
  seriesDescription: z.string().optional(),
  dayNight: z.string().optional(),
  rescheduledFrom: z.string().optional(),
  resumedFrom: z.string().optional(),
});

export const apiDateSchema = z.object({
  date: z.string(),
  totalGames: z.number().int().optional(),
  games: z.array(apiGameSchema),
});

export const apiScheduleSchema = z.object({
  totalGames: z.number().int().optional(),
  dates: z.array(apiDateSchema),
});

export type ApiGame = z.infer<typeof apiGameSchema>;
export type ApiDate = z.infer<typeof apiDateSchema>;
export type ApiSchedule = z.infer<typeof apiScheduleSchema>;
