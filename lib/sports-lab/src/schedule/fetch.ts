import { parseSchedule } from "./parse";
import { type DailySchedule } from "./types";

/** MLB Stats API base. Public, no auth required. */
export const MLB_STATS_API_BASE = "https://statsapi.mlb.com/api/v1";

/** `sportId=1` is Major League Baseball. */
export const MLB_SPORT_ID = 1;

/**
 * Minimal shape of the global `fetch`, narrowed to what we use. Declaring it
 * ourselves keeps the fetch layer injectable (and testable) without pulling in
 * DOM lib types.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

export interface FetchScheduleOptions {
  /**
   * Injected fetch implementation. Defaults to the runtime global `fetch`.
   * Tests pass a stub; production uses the real one when egress is available.
   */
  fetchImpl?: FetchLike;
  sportId?: number;
  baseUrl?: string;
  signal?: AbortSignal;
  /** Override the recorded fetch timestamp (mainly for deterministic tests). */
  fetchedAtUtc?: string;
}

/**
 * Build the `/schedule` URL for a given slate date. `hydrate=probablePitcher`
 * asks the API to inline the confirmed starters we depend on.
 */
export function buildScheduleUrl(
  date: string,
  options: { sportId?: number; baseUrl?: string } = {},
): string {
  const base = options.baseUrl ?? MLB_STATS_API_BASE;
  const sportId = options.sportId ?? MLB_SPORT_ID;
  const params = new URLSearchParams({
    sportId: String(sportId),
    date,
    hydrate: "probablePitcher,team,venue",
  });
  return `${base}/schedule?${params.toString()}`;
}

/**
 * Fetch the raw schedule JSON for a date. Returns the untouched upstream
 * payload so callers can cache the raw pull for auditing/backtesting.
 *
 * Throws on a non-2xx response (fail loudly — a bad pull must not masquerade
 * as an empty slate).
 */
export async function fetchScheduleRaw(
  date: string,
  options: FetchScheduleOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) {
    throw new Error(
      "No fetch implementation available. Pass options.fetchImpl or run on a runtime with global fetch.",
    );
  }

  const url = buildScheduleUrl(date, {
    sportId: options.sportId,
    baseUrl: options.baseUrl,
  });

  const response = await fetchImpl(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(
      `MLB schedule request failed: ${response.status} ${response.statusText} (${url})`,
    );
  }
  return response.json();
}

/**
 * Fetch and parse the schedule for a date into a clean {@link DailySchedule}.
 * Convenience wrapper over {@link fetchScheduleRaw} + parse.
 */
export async function fetchDailySchedule(
  date: string,
  options: FetchScheduleOptions = {},
): Promise<DailySchedule> {
  const raw = await fetchScheduleRaw(date, options);
  return parseSchedule(raw, { date, fetchedAtUtc: options.fetchedAtUtc });
}
