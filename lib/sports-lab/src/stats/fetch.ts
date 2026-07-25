import { MLB_STATS_API_BASE, type FetchLike } from "../schedule/fetch";
import {
  parsePitcherSeasonStats,
  parseTeamBattingStats,
  parseTeamPitchingStats,
} from "./parse";
import {
  type PitcherSeasonStats,
  type TeamBattingStats,
  type TeamPitchingStats,
} from "./types";

export interface StatsFetchOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  signal?: AbortSignal;
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  const impl = fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!impl) {
    throw new Error(
      "No fetch implementation available. Pass options.fetchImpl or run on a runtime with global fetch.",
    );
  }
  return impl;
}

async function getJson(url: string, options: StatsFetchOptions): Promise<unknown> {
  const impl = resolveFetch(options.fetchImpl);
  const response = await impl(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`MLB stats request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

/** `/people/{id}?hydrate=stats(group=[pitching],type=[season],season=YYYY)`. */
export function buildPitcherStatsUrl(
  playerId: number,
  season: string,
  options: { baseUrl?: string } = {},
): string {
  const base = options.baseUrl ?? MLB_STATS_API_BASE;
  const hydrate = `stats(group=[pitching],type=[season],season=${season})`;
  const params = new URLSearchParams({ hydrate });
  return `${base}/people/${playerId}?${params.toString()}`;
}

/** `/teams/{id}/stats?stats=season&group={hitting|pitching}&season=YYYY`. */
export function buildTeamStatsUrl(
  teamId: number,
  group: "hitting" | "pitching",
  season: string,
  options: { baseUrl?: string } = {},
): string {
  const base = options.baseUrl ?? MLB_STATS_API_BASE;
  const params = new URLSearchParams({ stats: "season", group, season });
  return `${base}/teams/${teamId}/stats?${params.toString()}`;
}

export async function fetchPitcherSeasonStats(
  playerId: number,
  season: string,
  options: StatsFetchOptions = {},
): Promise<PitcherSeasonStats> {
  const url = buildPitcherStatsUrl(playerId, season, { baseUrl: options.baseUrl });
  const raw = await getJson(url, options);
  return parsePitcherSeasonStats(raw, { season });
}

export async function fetchTeamBattingStats(
  teamId: number,
  teamName: string,
  season: string,
  options: StatsFetchOptions = {},
): Promise<TeamBattingStats> {
  const url = buildTeamStatsUrl(teamId, "hitting", season, { baseUrl: options.baseUrl });
  const raw = await getJson(url, options);
  return parseTeamBattingStats(raw, { season, teamId, teamName });
}

export async function fetchTeamPitchingStats(
  teamId: number,
  teamName: string,
  season: string,
  options: StatsFetchOptions = {},
): Promise<TeamPitchingStats> {
  const url = buildTeamStatsUrl(teamId, "pitching", season, { baseUrl: options.baseUrl });
  const raw = await getJson(url, options);
  return parseTeamPitchingStats(raw, { season, teamId, teamName });
}
