/**
 * Thin client for the public MLB Stats API.
 *
 * Design principles (from the project plan, Section 3 "Data principles"):
 *   - Fail loudly, not silently: non-2xx and malformed JSON throw, so a missing
 *     source downgrades a prediction rather than silently feeding a fake number.
 *   - Injectable transport: the `fetcher` is a constructor arg, so the same
 *     code runs against the live API, a recorded fixture set (offline), or a
 *     test double — no branching in the call sites.
 *   - Bounded and retried: every request has a timeout and bounded exponential
 *     backoff for transient network/5xx failures.
 *
 * NOTE: in restricted network environments `statsapi.mlb.com` may be blocked by
 * egress policy. That is expected — construct the client with a fixture-backed
 * fetcher (see mlb/fixtures.ts) to run the pipeline fully offline.
 */

import type {
  MlbBoxscoreResponse,
  MlbRosterResponse,
  MlbScheduleResponse,
  MlbStatsResponse,
} from "./types";

export const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";

/** Minimal fetch signature so any transport (live/fixture/test) can be injected. */
export type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface MlbClientOptions {
  fetcher?: Fetcher;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

export class MlbApiError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MlbApiError";
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export class MlbStatsClient {
  private readonly fetcher: Fetcher;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: MlbClientOptions = {}) {
    this.fetcher =
      opts.fetcher ?? ((url, init) => fetch(url, init) as ReturnType<Fetcher>);
    this.baseUrl = opts.baseUrl ?? MLB_API_BASE;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async getJson<T>(
    path: string,
    query: Record<string, string | number>,
  ): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(2 ** attempt * 250); // 500ms, 1s, 2s…
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetcher(url, { signal: controller.signal });
        if (!res.ok) {
          // 4xx (except 429) are not retryable — fail loudly right away.
          if (res.status < 500 && res.status !== 429) {
            throw new MlbApiError(`MLB API ${res.status}`, url, res.status);
          }
          lastErr = new MlbApiError(`MLB API ${res.status}`, url, res.status);
          continue;
        }
        return (await res.json()) as T;
      } catch (err) {
        if (
          err instanceof MlbApiError &&
          err.status &&
          err.status < 500 &&
          err.status !== 429
        ) {
          throw err;
        }
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new MlbApiError(
      `MLB API request failed after ${this.maxRetries + 1} attempts: ${String(lastErr)}`,
      path,
    );
  }

  /** Games on a date, with probable starters hydrated. */
  schedule(date: string): Promise<MlbScheduleResponse> {
    return this.getJson<MlbScheduleResponse>("/schedule", {
      sportId: 1,
      date,
      hydrate: "probablePitcher,team,venue",
    });
  }

  /** Per-game boxscore — pitcher usage lines for bullpen-workload tracking. */
  boxscore(gamePk: number): Promise<MlbBoxscoreResponse> {
    return this.getJson<MlbBoxscoreResponse>(`/game/${gamePk}/boxscore`, {});
  }

  /** Games on a date with linescore hydrated — final scores for settlement. */
  scheduleResults(date: string): Promise<MlbScheduleResponse> {
    return this.getJson<MlbScheduleResponse>("/schedule", {
      sportId: 1,
      date,
      hydrate: "team,linescore",
    });
  }

  /**
   * Point-in-time pitching stats: totals over [startDate, endDate]. The
   * backtest's no-look-ahead guarantee rests on these byDateRange pulls —
   * `stats=season` would leak the rest of the season into every "as of
   * day D" feature.
   */
  pitcherRange(
    personId: number,
    season: number,
    startDate: string,
    endDate: string,
  ): Promise<MlbStatsResponse> {
    return this.getJson<MlbStatsResponse>(`/people/${personId}/stats`, {
      stats: "byDateRange",
      group: "pitching",
      season,
      startDate,
      endDate,
    });
  }

  /** Point-in-time team hitting totals over [startDate, endDate]. */
  teamBattingRange(
    teamId: number,
    season: number,
    startDate: string,
    endDate: string,
  ): Promise<MlbStatsResponse> {
    return this.getJson<MlbStatsResponse>(`/teams/${teamId}/stats`, {
      stats: "byDateRange",
      group: "hitting",
      season,
      startDate,
      endDate,
    });
  }

  /**
   * Point-in-time team relief-pitching totals over [startDate, endDate].
   * sitCodes=rp mirrors teamPitchingSeason; if the live API rejects the
   * combination the caller degrades through the missing-bullpen flag rather
   * than inventing a number.
   */
  teamBullpenRange(
    teamId: number,
    season: number,
    startDate: string,
    endDate: string,
  ): Promise<MlbStatsResponse> {
    return this.getJson<MlbStatsResponse>(`/teams/${teamId}/stats`, {
      stats: "byDateRange",
      group: "pitching",
      sitCodes: "rp",
      season,
      startDate,
      endDate,
    });
  }

  /** Season pitching stats for a player (the probable starter). */
  pitcherSeason(personId: number, season: number): Promise<MlbStatsResponse> {
    return this.getJson<MlbStatsResponse>(`/people/${personId}/stats`, {
      stats: "season",
      group: "pitching",
      season,
    });
  }

  /** 40-man roster with player status — IL (injured list) detection. */
  teamRoster(teamId: number, season: number): Promise<MlbRosterResponse> {
    return this.getJson<MlbRosterResponse>(`/teams/${teamId}/roster`, {
      rosterType: "40Man",
      season,
    });
  }

  /** Season hitting stats for a team (the lineup as a whole). */
  teamBattingSeason(teamId: number, season: number): Promise<MlbStatsResponse> {
    return this.getJson<MlbStatsResponse>(`/teams/${teamId}/stats`, {
      stats: "season",
      group: "hitting",
      season,
    });
  }

  /**
   * Season pitching stats for a team, split by role. `sitCodes=rp` yields the
   * bullpen (relief-pitching) aggregate that Step 2 uses for the bullpen model.
   */
  teamPitchingSeason(
    teamId: number,
    season: number,
    role: "rp" | "sp" | "all" = "rp",
  ): Promise<MlbStatsResponse> {
    const query: Record<string, string | number> = {
      stats: role === "all" ? "season" : "statSplits",
      group: "pitching",
      season,
    };
    if (role !== "all") query.sitCodes = role;
    return this.getJson<MlbStatsResponse>(`/teams/${teamId}/stats`, query);
  }
}
