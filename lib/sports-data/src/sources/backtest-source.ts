/**
 * Point-in-time CoreDataSource for the walk-forward backtest.
 *
 * Every stats query is bounded to [season opening, D−1] for the day D being
 * predicted, via the API's byDateRange stats — the same real feed production
 * reads, restricted to what was knowable the evening before the games. A
 * plain `stats=season` pull would silently include SEPTEMBER in an April
 * prediction, and every conclusion drawn from such a backtest would be
 * fiction.
 *
 * Caching sits at the FETCHER, keyed by request URL: every endpoint any part
 * of the pipeline touches (schedules, stats, form scans) is cached uniformly
 * as the RAW response — real data, verbatim, never derived numbers — so a
 * season replay costs one network pass and re-runs are free and identical.
 *
 * Known, deliberate gaps (each degrades through production's own flags and
 * is stated in the backtest report rather than papered over):
 *   - bullpen WORKLOADS (3-day usage → fatigue) are not reconstructed; that
 *     would need ~90 boxscore pulls per day. The fatigue penalty is simply
 *     absent, exactly like a production run with --skip-workloads.
 *   - probable starters come from the schedule's probablePitcher hydration
 *     for the historical date; where the feed no longer carries one, the
 *     game wears the same no_probable_pitcher downgrade as production.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { MlbApiError, MlbStatsClient, type Fetcher } from "../mlb/client";
import {
  firstSplitStat,
  normalizeSchedule,
  parseBattingLine,
  parsePitchingLine,
  type NormalizedGame,
} from "../mlb/parse";
import type { RawBattingLine, RawPitchingLine } from "../sabermetrics";
import type { CoreDataSource, TeamRecentForm } from "../step2";
import { buildForms } from "./form-builder";
import { getParkFactor } from "./park-factors";

/**
 * HTTP statuses that describe the ENTITY asked about rather than the run
 * asking. Only these degrade to "missing data" (see `orNull`).
 */
const MISSING_ENTITY_STATUS = new Set([400, 404, 422]);

/**
 * A fetcher that serves from an on-disk, URL-keyed store of raw responses
 * and fills it from the given transport on miss.
 */
export function cachingFetcher(cacheDir: string, inner?: Fetcher): Fetcher {
  const transport: Fetcher =
    inner ?? ((url, init) => fetch(url, init) as ReturnType<Fetcher>);
  return async (url, init) => {
    const key = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const path = join(cacheDir, `${key}.json`);
    if (existsSync(path)) {
      const body = readFileSync(path, "utf8");
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(body),
      } as Awaited<ReturnType<Fetcher>>;
    }
    const res = await transport(url, init);
    if (!res.ok) return res; // errors are never cached
    const data = await res.json();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
    return {
      ok: true,
      status: 200,
      json: async () => data,
    } as Awaited<ReturnType<Fetcher>>;
  };
}

export interface BacktestSourceOptions {
  /** Directory for the raw-response cache (git-ignored). */
  cacheDir: string;
  season: number;
  /** First calendar day of the season's stats window (opening day). */
  seasonStart: string;
  /** Override transport (tests); defaults to real fetch through the cache. */
  fetcher?: Fetcher;
}

export class BacktestDataSource implements CoreDataSource {
  readonly client: MlbStatsClient;
  private readonly season: number;
  private readonly seasonStart: string;
  /** The day being predicted; stats windows end the day BEFORE this. */
  private asOf = "";
  private forms: Record<string, TeamRecentForm> = {};

  constructor(opts: BacktestSourceOptions) {
    this.client = new MlbStatsClient({
      fetcher: cachingFetcher(opts.cacheDir, opts.fetcher),
    });
    this.season = opts.season;
    this.seasonStart = opts.seasonStart;
  }

  /** End of every stats window: the day before the slate. */
  private statsEnd(): string {
    const d = new Date(`${this.asOf}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Position the source on a slate date and prefetch recent form for the
   * slate's teams (buildForms walks scheduleResults backwards from D−1, so
   * it is point-in-time by construction).
   */
  async setDate(date: string, teamIds: number[]): Promise<void> {
    this.asOf = date;
    this.forms = {};
    if (teamIds.length === 0) return;
    const report = await buildForms({ date, client: this.client, teamIds });
    this.forms = report.forms;
  }

  async getSchedule(date: string): Promise<NormalizedGame[]> {
    this.asOf = date;
    // Regular-season games only. The All-Star Game sits in the same schedule
    // feed with synthetic AL/NL "teams" whose stats endpoints 404, and
    // exhibition/spring games are not what the production book predicts.
    // Games with no gameType (old feeds, fixtures) are kept — filtering is
    // for the marked specials, not a guess.
    return normalizeSchedule(await this.client.schedule(date)).filter(
      (g) => g.gameType === null || g.gameType === "R",
    );
  }

  /** Final scores for settlement — Final games with a score, only. */
  async getResults(
    date: string,
  ): Promise<Record<string, { homeScore: number; awayScore: number }>> {
    const out: Record<string, { homeScore: number; awayScore: number }> = {};
    for (const g of normalizeSchedule(await this.client.scheduleResults(date))) {
      if (g.abstractState !== "Final") continue;
      if (g.home.score === null || g.away.score === null) continue;
      out[String(g.gamePk)] = {
        homeScore: g.home.score,
        awayScore: g.away.score,
      };
    }
    return out;
  }

  /**
   * A stats endpoint rejecting the request for THIS ENTITY means the API has
   * no record for it over that window — which is exactly "missing data":
   * return null and let the assembler attach its downgrade flag, instead of
   * aborting a whole season replay on one unknowable pitcher.
   *
   * 404 is the common case, but the MLB API also answers 400 for an id it
   * does not recognise and 422 for a window it will not serve, and both used
   * to kill a multi-hour replay outright. Anything else — 401/403 (our
   * credentials or our IP), 429 (we are being throttled), 5xx (their problem)
   * — is a fault of the RUN, not a property of the entity: those still throw,
   * because degrading them to null would fabricate a season of "missing data"
   * out of an outage and quietly rewrite the very record we are measuring.
   */
  private async orNull<T>(pull: () => Promise<T>): Promise<T | null> {
    try {
      return await pull();
    } catch (err) {
      if (err instanceof MlbApiError && MISSING_ENTITY_STATUS.has(err.status ?? 0)) {
        return null;
      }
      throw err;
    }
  }

  async getStarterLine(
    pitcherId: number,
    season: number,
  ): Promise<RawPitchingLine | null> {
    const res = await this.orNull(() =>
      this.client.pitcherRange(
        pitcherId,
        season,
        this.seasonStart,
        this.statsEnd(),
      ),
    );
    if (!res) return null;
    const stat = firstSplitStat(res);
    return stat ? parsePitchingLine(stat, `pitcher ${pitcherId}`) : null;
  }

  async getTeamBattingLine(
    teamId: number,
    season: number,
  ): Promise<RawBattingLine | null> {
    const res = await this.orNull(() =>
      this.client.teamBattingRange(
        teamId,
        season,
        this.seasonStart,
        this.statsEnd(),
      ),
    );
    if (!res) return null;
    const stat = firstSplitStat(res);
    return stat ? parseBattingLine(stat, `team ${teamId} batting`) : null;
  }

  async getBullpenLine(
    teamId: number,
    season: number,
  ): Promise<RawPitchingLine | null> {
    const res = await this.orNull(() =>
      this.client.teamBullpenRange(
        teamId,
        season,
        this.seasonStart,
        this.statsEnd(),
      ),
    );
    if (!res) return null;
    const stat = firstSplitStat(res);
    return stat ? parsePitchingLine(stat, `team ${teamId} bullpen`) : null;
  }

  async getParkFactor(venueId: number | null): Promise<number | undefined> {
    return getParkFactor(venueId);
  }

  async getRecentForm(teamId: number): Promise<TeamRecentForm | undefined> {
    return this.forms[String(teamId)];
  }
}
