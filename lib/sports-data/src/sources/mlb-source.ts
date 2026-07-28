/**
 * Live/cached CoreDataSource backed by the MLB Stats API client.
 *
 * Wraps MlbStatsClient + parsers behind the orchestrator's CoreDataSource
 * interface, with an optional DailyCache in front of every pull (plan Section 3:
 * cache daily, timestamp everything). Returns `null` — not a throw — when a
 * source has no data for an entity, so a single missing team/pitcher downgrades
 * one game rather than aborting the whole slate.
 */

import type { DailyCache } from "../mlb/cache";
import { MlbStatsClient } from "../mlb/client";
import {
  firstSplitStat,
  normalizeSchedule,
  parseBattingLine,
  parsePitchingLine,
  type NormalizedGame,
} from "../mlb/parse";
import type { RawBattingLine, RawPitchingLine } from "../sabermetrics";
import type { CoreDataSource } from "../step2";

export interface MlbCoreDataSourceOptions {
  client?: MlbStatsClient;
  cache?: DailyCache;
  /** Date key used to namespace the cache (defaults to the schedule date). */
  cacheDate?: string;
}

export class MlbCoreDataSource implements CoreDataSource {
  private readonly client: MlbStatsClient;
  private readonly cache?: DailyCache;
  private cacheDate: string;

  constructor(opts: MlbCoreDataSourceOptions = {}) {
    this.client = opts.client ?? new MlbStatsClient();
    this.cache = opts.cache;
    this.cacheDate = opts.cacheDate ?? "unknown-date";
  }

  private async cached<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
    if (!this.cache) return fetchFn();
    const entry = await this.cache.getOrFetch(this.cacheDate, key, fetchFn);
    return entry.data;
  }

  async getSchedule(date: string): Promise<NormalizedGame[]> {
    this.cacheDate = date;
    const res = await this.cached(`schedule`, () => this.client.schedule(date));
    return normalizeSchedule(res);
  }

  async getStarterLine(
    pitcherId: number,
    season: number,
  ): Promise<RawPitchingLine | null> {
    const res = await this.cached(`pitcher_${pitcherId}_${season}`, () =>
      this.client.pitcherSeason(pitcherId, season),
    );
    const stat = firstSplitStat(res);
    return stat ? parsePitchingLine(stat, `pitcher ${pitcherId}`) : null;
  }

  async getTeamBattingLine(
    teamId: number,
    season: number,
  ): Promise<RawBattingLine | null> {
    const res = await this.cached(`team_bat_${teamId}_${season}`, () =>
      this.client.teamBattingSeason(teamId, season),
    );
    const stat = firstSplitStat(res);
    return stat ? parseBattingLine(stat, `team ${teamId} batting`) : null;
  }

  async getBullpenLine(
    teamId: number,
    season: number,
  ): Promise<RawPitchingLine | null> {
    const res = await this.cached(`team_pen_${teamId}_${season}`, () =>
      this.client.teamPitchingSeason(teamId, season, "rp"),
    );
    const stat = firstSplitStat(res);
    return stat ? parsePitchingLine(stat, `team ${teamId} bullpen`) : null;
  }
}
