/**
 * Shared parsing for MLB Stats API payloads.
 *
 * The API returns most rate stats as strings (".312", "3.45", "-.--") and
 * innings in baseball notation ("112.1" = 112 and 1/3 innings). It also omits
 * fields freely. These helpers turn all of that into `number | null` — never
 * into 0, which would quietly look like a real, terrible stat line.
 */

import { z } from "zod/v4";

/** Parse a stat that may arrive as a number, a numeric string, or junk. */
export function statNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "-.--" || trimmed === ".---") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Innings pitched in baseball notation to a real number of innings.
 * "112.1" -> 112.3333, "112.2" -> 112.6667, "112.0" -> 112.
 */
export function parseInningsPitched(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^(-?\d+)(?:\.(\d))?$/.exec(trimmed);
  if (!match) {
    const fallback = Number(trimmed);
    return Number.isFinite(fallback) ? fallback : null;
  }
  const whole = Number(match[1]);
  const thirds = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isFinite(whole)) return null;
  // Only .0/.1/.2 are meaningful; anything else is treated as a decimal.
  if (thirds > 2) return Number(trimmed);
  return whole + thirds / 3;
}

/** Per-9-innings rate, or null when either input is unusable. */
export function per9(count: number | null, inningsPitched: number | null): number | null {
  if (count === null || inningsPitched === null || inningsPitched <= 0) return null;
  return (count * 9) / inningsPitched;
}

/**
 * A 3-letter fallback abbreviation, used only when the API omits one.
 *
 * It cannot reproduce MLB's official codes (those are city-based: "Toronto Blue
 * Jays" is TOR, not TBJ). It only needs to be short, stable and recognisable:
 * initials when there are three or more words, otherwise the first three
 * letters of the last word.
 */
export function deriveAbbrev(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "???";
  const initials = words.map((word) => word[0]!).join("").toUpperCase();
  if (initials.length >= 3) return initials.slice(0, 3);
  // Short names fall back to the last word, padded so the width is always 3.
  return words[words.length - 1]!.slice(0, 3).toUpperCase().padEnd(3, "?");
}

// ---------------------------------------------------------------------------
// Loose schemas. We validate *shape*, not completeness: MLB adds and removes
// fields between seasons and a strict schema would break the pipeline for no
// benefit. Unknown keys pass through; missing keys become undefined.
// ---------------------------------------------------------------------------

const looseRecord = z.record(z.string(), z.unknown());

export const teamNodeSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  abbreviation: z.string().optional(),
  teamName: z.string().optional(),
});

export const personNodeSchema = z.object({
  id: z.number().optional(),
  fullName: z.string().optional(),
  pitchHand: z.object({ code: z.string().optional() }).optional(),
});

export const statSplitSchema = z.object({
  season: z.union([z.string(), z.number()]).optional(),
  stat: looseRecord.optional(),
  team: teamNodeSchema.optional(),
  player: personNodeSchema.optional(),
  numTeams: z.number().optional(),
});

export const statGroupSchema = z.object({
  type: looseRecord.optional(),
  group: looseRecord.optional(),
  splits: z.array(statSplitSchema).optional(),
});

export const statsEnvelopeSchema = z.object({
  stats: z.array(statGroupSchema).optional(),
});

export type StatSplit = z.infer<typeof statSplitSchema>;

export const linescoreTeamSchema = z.object({
  runs: z.number().optional(),
  hits: z.number().optional(),
  errors: z.number().optional(),
});

export const scheduleGameSchema = z.object({
  gamePk: z.number(),
  gameDate: z.string().optional(),
  officialDate: z.string().optional(),
  gameType: z.string().optional(),
  doubleHeader: z.string().optional(),
  gameNumber: z.number().optional(),
  status: z
    .object({
      detailedState: z.string().optional(),
      abstractGameState: z.string().optional(),
      codedGameState: z.string().optional(),
    })
    .optional(),
  venue: z.object({ id: z.number().optional(), name: z.string().optional() }).optional(),
  linescore: z
    .object({
      currentInning: z.number().optional(),
      scheduledInnings: z.number().optional(),
      teams: z
        .object({
          home: linescoreTeamSchema.optional(),
          away: linescoreTeamSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  teams: z.object({
    home: z
      .object({
        team: teamNodeSchema.optional(),
        probablePitcher: personNodeSchema.optional(),
        score: z.number().optional(),
        isWinner: z.boolean().optional(),
      })
      .optional(),
    away: z
      .object({
        team: teamNodeSchema.optional(),
        probablePitcher: personNodeSchema.optional(),
        score: z.number().optional(),
        isWinner: z.boolean().optional(),
      })
      .optional(),
  }),
});

export const scheduleEnvelopeSchema = z.object({
  dates: z
    .array(
      z.object({
        date: z.string().optional(),
        games: z.array(scheduleGameSchema).optional(),
      }),
    )
    .optional(),
});

export type ScheduleGameNode = z.infer<typeof scheduleGameSchema>;

export const peopleEnvelopeSchema = z.object({
  people: z
    .array(
      z.object({
        id: z.number().optional(),
        fullName: z.string().optional(),
        pitchHand: z.object({ code: z.string().optional() }).optional(),
        stats: z.array(statGroupSchema).optional(),
      }),
    )
    .optional(),
});

export const rosterEnvelopeSchema = z.object({
  roster: z
    .array(
      z.object({
        person: personNodeSchema.optional(),
        position: z.object({ abbreviation: z.string().optional() }).optional(),
        status: z
          .object({ code: z.string().optional(), description: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
});

export const venueEnvelopeSchema = z.object({
  venues: z
    .array(
      z.object({
        id: z.number().optional(),
        name: z.string().optional(),
        location: z
          .object({
            defaultCoordinates: z
              .object({ latitude: z.number().optional(), longitude: z.number().optional() })
              .optional(),
            azimuthAngle: z.union([z.number(), z.string()]).optional(),
            elevation: z.union([z.number(), z.string()]).optional(),
          })
          .optional(),
        fieldInfo: z.object({ roofType: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});
