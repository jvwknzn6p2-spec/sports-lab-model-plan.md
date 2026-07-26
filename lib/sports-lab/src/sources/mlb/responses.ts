/**
 * Steps 1–2 — MLB Stats API response shapes and value parsing.
 *
 * The public MLB Stats API (`https://statsapi.mlb.com/api/v1`) returns large,
 * loosely-typed documents that gain fields over time. These schemas describe
 * only the fields we actually read; zod strips the rest, so an upstream
 * addition never breaks us, while a *removal or rename* fails loudly at the
 * boundary instead of surfacing as a mysterious `null` three layers down.
 *
 * Two value quirks in this API are genuine traps and are handled in one place
 * here rather than at each call site:
 *
 *   1. **Rate stats arrive as strings** — `"3.20"`, `".320"`, `"-.--"`.
 *   2. **Innings pitched uses baseball notation, not decimals.** `"120.1"`
 *      means 120 *and one third* innings, not 120.1. Reading it as a float
 *      silently understates workload on two thirds of all values.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Value parsing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parse a stat that the API returns as a string (or occasionally a number).
 *
 * The API uses placeholder strings such as `"-.--"`, `"-"` and `".---"` for
 * "not applicable" (e.g. a position player's ERA). Those become null rather
 * than NaN, so a missing stat is flagged by the validation layer instead of
 * poisoning arithmetic.
 */
export function parseStatNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || /^[-.]+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse innings pitched from baseball notation into true innings.
 *
 * The fractional digit counts *outs*, not tenths: `.1` is one out (⅓ of an
 * inning) and `.2` is two outs (⅔). So `"120.1"` is 120.333…, not 120.1.
 * Any other fractional digit is not valid notation and is rejected rather
 * than guessed at.
 */
export function parseInningsPitched(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || /^[-.]+$/.test(trimmed)) return null;

  const match = /^(\d+)(?:\.(\d))?$/.exec(trimmed);
  if (match === null) return null;

  const whole = Number(match[1]);
  if (match[2] === undefined) return whole;

  const outs = Number(match[2]);
  if (outs > 2) return null; // .3+ is not valid outs notation
  return whole + outs / 3;
}

/* -------------------------------------------------------------------------- */
/* Shared fragments                                                           */
/* -------------------------------------------------------------------------- */

const teamRefResponse = z.object({
  id: z.number().int(),
  name: z.string(),
  // Present only when the request hydrates teams; resolved separately when absent.
  abbreviation: z.string().optional(),
});

const venueResponse = z.object({
  id: z.number().int(),
  name: z.string(),
});

const probablePitcherResponse = z.object({
  id: z.number().int(),
  fullName: z.string(),
});

/* -------------------------------------------------------------------------- */
/* /api/v1/schedule                                                           */
/* -------------------------------------------------------------------------- */

const scheduleTeamSide = z.object({
  team: teamRefResponse,
  probablePitcher: probablePitcherResponse.optional(),
  /** Present on completed games. */
  score: z.number().int().optional(),
});

export const scheduleGameSchema = z.object({
  gamePk: z.number().int(),
  gameDate: z.string(),
  /** e.g. "Preview" | "Live" | "Final". */
  status: z.object({
    abstractGameState: z.string(),
    detailedState: z.string().optional(),
  }),
  teams: z.object({ home: scheduleTeamSide, away: scheduleTeamSide }),
  venue: venueResponse.optional(),
  /** "R" regular season, "S" spring, "P" postseason. */
  gameType: z.string().optional(),
});
export type ScheduleGame = z.infer<typeof scheduleGameSchema>;

export const scheduleResponseSchema = z.object({
  dates: z.array(z.object({ date: z.string(), games: z.array(scheduleGameSchema) })).default([]),
});
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

/* -------------------------------------------------------------------------- */
/* /api/v1/teams                                                              */
/* -------------------------------------------------------------------------- */

export const teamsResponseSchema = z.object({
  teams: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      abbreviation: z.string().optional(),
    }),
  ),
});

/* -------------------------------------------------------------------------- */
/* Stats endpoints                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The stats envelope shared by `/people/{id}/stats` and `/teams/{id}/stats`.
 *
 * `stat` is left as an open record: which keys are present depends on the
 * group requested, and each reader pulls what it needs through
 * {@link parseStatNumber}.
 */
export const statsResponseSchema = z.object({
  stats: z
    .array(
      z.object({
        type: z.object({ displayName: z.string() }).optional(),
        group: z.object({ displayName: z.string() }).optional(),
        splits: z
          .array(
            z.object({
              season: z.string().optional(),
              stat: z.record(z.string(), z.unknown()).default({}),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

/**
 * Pull the first split's stat record for a given group.
 *
 * Returns null rather than an empty object when the group is absent, so a
 * caller can tell "the API had no data" from "the data was all zeroes".
 */
export function firstSplitStat(
  response: StatsResponse,
  group?: string,
): Record<string, unknown> | null {
  for (const entry of response.stats) {
    if (group !== undefined && entry.group?.displayName !== group) continue;
    const split = entry.splits[0];
    if (split !== undefined) return split.stat;
  }
  return null;
}
