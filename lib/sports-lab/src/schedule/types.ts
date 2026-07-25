import { z } from "zod";

/**
 * Schedule domain types + validation.
 *
 * There are two layers here on purpose:
 *
 *  - The `Raw*` schemas describe the *subset* of the MLB Stats API
 *    `/api/v1/schedule` response that we actually consume. They are
 *    deliberately permissive about unknown keys (the upstream payload is huge
 *    and changes over time) but strict about the fields we depend on — if one
 *    of those is missing or the wrong type, parsing fails loudly rather than
 *    silently producing a half-built game.
 *
 *  - The `*` domain schemas describe our clean, storable shape. This is the
 *    source of truth the rest of the pipeline (baseline model, simulation,
 *    backtesting) builds on, and the shape we cache to disk.
 *
 * Design note — "flag, never fake": a *structurally broken* payload throws,
 * but *legitimately absent* data (e.g. a starter not yet confirmed) is not an
 * error. It is recorded as `null` and surfaced via `dataFlags` so downstream
 * stages can downgrade confidence instead of trusting a fabricated value.
 */

// ---------------------------------------------------------------------------
// Raw MLB Stats API subset (only the fields we read)
// ---------------------------------------------------------------------------

const RawTeamRef = z.object({
  id: z.number().int(),
  name: z.string().min(1),
});

const RawProbablePitcher = z.object({
  id: z.number().int(),
  fullName: z.string().min(1),
});

const RawTeamSide = z.object({
  team: RawTeamRef,
  // Absent until the club confirms a starter. Optional on purpose.
  probablePitcher: RawProbablePitcher.optional(),
});

const RawStatus = z.object({
  abstractGameState: z.string().min(1),
  detailedState: z.string().min(1),
  codedGameState: z.string().min(1),
});

const RawVenue = z.object({
  id: z.number().int(),
  name: z.string().min(1),
});

const RawGame = z.object({
  gamePk: z.number().int(),
  gameDate: z.string().min(1),
  status: RawStatus,
  teams: z.object({
    home: RawTeamSide,
    away: RawTeamSide,
  }),
  venue: RawVenue,
  doubleHeader: z.string().optional(),
  gameNumber: z.number().int().optional(),
});

const RawDate = z.object({
  date: z.string().min(1),
  games: z.array(RawGame),
});

export const RawScheduleResponse = z.object({
  dates: z.array(RawDate),
});

export type RawScheduleResponse = z.infer<typeof RawScheduleResponse>;

// ---------------------------------------------------------------------------
// Clean domain shape (what we store and pass downstream)
// ---------------------------------------------------------------------------

export const ProbablePitcher = z.object({
  id: z.number().int(),
  fullName: z.string(),
});
export type ProbablePitcher = z.infer<typeof ProbablePitcher>;

export const TeamSide = z.object({
  teamId: z.number().int(),
  teamName: z.string(),
  /** `null` when the club has not confirmed a starter yet. Never fabricated. */
  probablePitcher: ProbablePitcher.nullable(),
});
export type TeamSide = z.infer<typeof TeamSide>;

export const GameStatus = z.object({
  abstract: z.string(),
  detailed: z.string(),
  coded: z.string(),
});
export type GameStatus = z.infer<typeof GameStatus>;

export const Venue = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type Venue = z.infer<typeof Venue>;

export const ScheduledGame = z.object({
  gamePk: z.number().int(),
  /** Scheduled first pitch, ISO-8601 UTC (as reported upstream). */
  gameDateUtc: z.string(),
  status: GameStatus,
  venue: Venue,
  home: TeamSide,
  away: TeamSide,
  /** "N" single game, "Y"/"S" doubleheader variants (upstream convention). */
  doubleHeader: z.string(),
  gameNumber: z.number().int(),
  /**
   * Machine-readable notes about missing/soft data for this game, e.g.
   * "missing_probable_pitcher:home". Empty means the row is fully sourced.
   */
  dataFlags: z.array(z.string()),
});
export type ScheduledGame = z.infer<typeof ScheduledGame>;

export const DailySchedule = z.object({
  /** Requested slate date, `YYYY-MM-DD`. */
  date: z.string(),
  /** When this pull was fetched, ISO-8601 UTC. Timestamp everything. */
  fetchedAtUtc: z.string(),
  source: z.literal("mlb-stats-api"),
  games: z.array(ScheduledGame),
});
export type DailySchedule = z.infer<typeof DailySchedule>;
