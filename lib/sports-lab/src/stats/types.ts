import { z } from "zod";

/**
 * Core game-data stats (plan Section 3 / build Step 2): starting pitchers,
 * team batting, and bullpen/team pitching.
 *
 * As in the schedule slice there are two layers:
 *  - `Raw*` schemas: the subset of the MLB Stats API `/people/{id}/stats` and
 *    `/teams/{id}/stats` responses we actually read. The API returns rate
 *    stats as strings and omits fields it has no value for, so raw stat maps
 *    are permissive (`z.record`) and the parsers do the numeric coercion.
 *  - domain schemas: clean numeric shapes with explicit `null` for
 *    absent/unsourced fields plus a `dataFlags` trail — flag, never fake.
 */

// ---------------------------------------------------------------------------
// Raw MLB Stats API subset
// ---------------------------------------------------------------------------

/** A single stat map is a loose record of string|number|null; parsers coerce. */
const RawStatMap = z.record(z.string(), z.unknown());

const RawSplit = z.object({
  season: z.string().optional(),
  team: z.object({ id: z.number().int(), name: z.string() }).optional(),
  stat: RawStatMap,
});

const RawStatGroup = z.object({
  type: z.object({ displayName: z.string() }).optional(),
  group: z.object({ displayName: z.string() }).optional(),
  splits: z.array(RawSplit),
});

/** `/api/v1/people/{id}?hydrate=stats(...)` → `{ people: [{ id, fullName, stats }] }`. */
export const RawPeopleStatsResponse = z.object({
  people: z.array(
    z.object({
      id: z.number().int(),
      fullName: z.string().min(1),
      stats: z.array(RawStatGroup).optional(),
    }),
  ),
});
export type RawPeopleStatsResponse = z.infer<typeof RawPeopleStatsResponse>;

/** `/api/v1/teams/{id}/stats?...` → `{ stats: [{ group, splits }] }`. */
export const RawTeamStatsResponse = z.object({
  stats: z.array(RawStatGroup),
});
export type RawTeamStatsResponse = z.infer<typeof RawTeamStatsResponse>;

// ---------------------------------------------------------------------------
// Clean domain shapes
// ---------------------------------------------------------------------------

export const PitcherSeasonStats = z.object({
  playerId: z.number().int(),
  fullName: z.string(),
  season: z.string(),
  era: z.number().nullable(),
  whip: z.number().nullable(),
  strikeoutsPer9: z.number().nullable(),
  /** Decimal innings (baseball thirds notation already converted). */
  inningsPitched: z.number().nullable(),
  gamesStarted: z.number().nullable(),
  dataFlags: z.array(z.string()),
});
export type PitcherSeasonStats = z.infer<typeof PitcherSeasonStats>;

export const TeamBattingStats = z.object({
  teamId: z.number().int(),
  teamName: z.string(),
  season: z.string(),
  runs: z.number().nullable(),
  obp: z.number().nullable(),
  slg: z.number().nullable(),
  ops: z.number().nullable(),
  avg: z.number().nullable(),
  /**
   * wOBA is in the plan but NOT provided by the free MLB Stats API hitting
   * object. It stays `null` here (flagged `unsourced:woba`) until a derivation
   * or paid source is added — never approximated silently.
   */
  woba: z.number().nullable(),
  dataFlags: z.array(z.string()),
});
export type TeamBattingStats = z.infer<typeof TeamBattingStats>;

/**
 * Team pitching used as the v1.0 **bullpen proxy**. True bullpen-only splits
 * (relievers excluding starters) require roster-level aggregation the free API
 * doesn't hand back directly, so `bullpenSpecific` is `false` and
 * `recentWorkload` is `null` until that data is wired in. Honest about being a
 * team-level stand-in rather than faking reliever-only numbers.
 */
export const TeamPitchingStats = z.object({
  teamId: z.number().int(),
  teamName: z.string(),
  season: z.string(),
  era: z.number().nullable(),
  whip: z.number().nullable(),
  strikeoutsPer9: z.number().nullable(),
  inningsPitched: z.number().nullable(),
  saves: z.number().nullable(),
  /** False when these are team-wide (starters+relievers) numbers. */
  bullpenSpecific: z.boolean(),
  /** Recent reliever workload/fatigue — not yet sourced; `null`, not faked. */
  recentWorkload: z.null(),
  dataFlags: z.array(z.string()),
});
export type TeamPitchingStats = z.infer<typeof TeamPitchingStats>;

// ---------------------------------------------------------------------------
// Per-game bundle (ties Step-1 schedule to Step-2 stats)
// ---------------------------------------------------------------------------

export const TeamStatSide = z.object({
  teamId: z.number().int(),
  teamName: z.string(),
  batting: TeamBattingStats,
  pitchingStaff: TeamPitchingStats,
  /** `null` when the club has no confirmed starter for this game. */
  probableStarter: PitcherSeasonStats.nullable(),
});
export type TeamStatSide = z.infer<typeof TeamStatSide>;

export const GameStatBundle = z.object({
  gamePk: z.number().int(),
  season: z.string(),
  /** When this bundle was assembled, ISO-8601 UTC. */
  assembledAtUtc: z.string(),
  home: TeamStatSide,
  away: TeamStatSide,
  /** Aggregated flags across both sides (schedule + stats). */
  dataFlags: z.array(z.string()),
});
export type GameStatBundle = z.infer<typeof GameStatBundle>;
