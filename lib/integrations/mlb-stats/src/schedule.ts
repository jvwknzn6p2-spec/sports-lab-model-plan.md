/**
 * The schedule fetch — build step 1.
 *
 * `fetchSchedule("2026-07-25")` is the smallest end-to-end slice of the daily
 * pipeline: one request, validated, normalised, and timestamped, ready to be
 * stored.
 */

import { apiScheduleSchema } from "./api-schema.ts";
import { MlbApiError, requestJson, type ClientOptions } from "./client.ts";
import { normalizeGame } from "./normalize.ts";
import type { ScheduledGame, ScheduleSnapshot } from "./types.ts";

/** `sportId=1` is Major League Baseball. Minor leagues and international play have their own ids. */
export const MLB_SPORT_ID = 1;

export interface FetchScheduleOptions extends ClientOptions {
  /**
   * Hydrations to request.
   *
   * `probablePitcher` is not optional in practice — the starting pitcher is the
   * biggest single driver of a game's outcome, and without this the schedule
   * comes back with no pitcher at all.
   */
  readonly hydrate?: readonly string[];
  readonly sportId?: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertValidDate(date: string, label: string): void {
  if (!DATE_PATTERN.test(date)) {
    throw new RangeError(`${label} must be YYYY-MM-DD, got "${date}"`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`${label} is not a real date: "${date}"`);
  }
}

function summarise(date: string, games: ScheduledGame[], fetchedAt: string): ScheduleSnapshot {
  return {
    date,
    games,
    fetchedAt,
    counts: {
      total: games.length,
      predictable: games.filter((game) => game.isPredictable).length,
      postponed: games.filter((game) => game.status === "postponed").length,
      missingPitchers: games.filter(
        (game) =>
          game.flags.includes("missing-home-pitcher") ||
          game.flags.includes("missing-away-pitcher"),
      ).length,
    },
  };
}

/**
 * Parse and normalise a raw schedule payload.
 *
 * Split out from the fetch so the parsing path can be tested against recorded
 * fixtures without touching the network.
 */
export function parseSchedule(payload: unknown, date: string, fetchedAt: string): ScheduleSnapshot {
  const parsed = apiScheduleSchema.safeParse(payload);
  if (!parsed.success) {
    // Surfaced as an API error rather than a Zod error so callers have one
    // error type to handle, with the offending field named in the message.
    throw new MlbApiError(
      "invalid-response",
      `MLB Stats API response did not match the expected schema: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
        .join("; ")}`,
      { url: `schedule?date=${date}` },
    );
  }

  // The API returns one entry per date. An empty `dates` array is the normal
  // response for an off day, not an error.
  const games = parsed.data.dates
    .filter((entry) => entry.date === date || parsed.data.dates.length === 1)
    .flatMap((entry) => entry.games)
    .map(normalizeGame)
    // Doubleheaders arrive in an arbitrary order; sort so output is stable.
    .sort((a, b) =>
      a.startTime === b.startTime
        ? a.gameNumber - b.gameNumber
        : a.startTime.localeCompare(b.startTime),
    );

  return summarise(date, games, fetchedAt);
}

/**
 * Fetch one day's MLB schedule.
 *
 * ```ts
 * const snapshot = await fetchSchedule("2026-07-25");
 * snapshot.games.filter((game) => game.isPredictable);
 * ```
 */
export async function fetchSchedule(
  date: string,
  options: FetchScheduleOptions = {},
): Promise<ScheduleSnapshot> {
  assertValidDate(date, "date");

  const hydrate = options.hydrate ?? ["probablePitcher"];
  const payload = await requestJson(
    "schedule",
    {
      sportId: options.sportId ?? MLB_SPORT_ID,
      date,
      hydrate: hydrate.length > 0 ? hydrate.join(",") : undefined,
    },
    options,
  );

  return parseSchedule(payload, date, new Date().toISOString());
}

/**
 * Fetch an inclusive range of dates in one request.
 *
 * Needed for backfilling history before a backtest (build step 8). Uses the
 * API's own `startDate`/`endDate` parameters, so a month costs one request
 * rather than thirty.
 */
export async function fetchScheduleRange(
  startDate: string,
  endDate: string,
  options: FetchScheduleOptions = {},
): Promise<ScheduleSnapshot[]> {
  assertValidDate(startDate, "startDate");
  assertValidDate(endDate, "endDate");
  if (startDate > endDate) {
    throw new RangeError(`startDate ${startDate} is after endDate ${endDate}`);
  }

  const hydrate = options.hydrate ?? ["probablePitcher"];
  const payload = await requestJson(
    "schedule",
    {
      sportId: options.sportId ?? MLB_SPORT_ID,
      startDate,
      endDate,
      hydrate: hydrate.length > 0 ? hydrate.join(",") : undefined,
    },
    options,
  );

  const fetchedAt = new Date().toISOString();
  const parsed = apiScheduleSchema.safeParse(payload);
  if (!parsed.success) {
    throw new MlbApiError("invalid-response", "MLB Stats API range response did not validate", {
      url: `schedule?startDate=${startDate}&endDate=${endDate}`,
    });
  }

  return parsed.data.dates.map((entry) =>
    summarise(
      entry.date,
      entry.games.map(normalizeGame).sort((a, b) =>
        a.startTime === b.startTime
          ? a.gameNumber - b.gameNumber
          : a.startTime.localeCompare(b.startTime),
      ),
      fetchedAt,
    ),
  );
}
