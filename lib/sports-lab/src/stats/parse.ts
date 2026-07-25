import {
  RawPeopleStatsResponse,
  RawTeamStatsResponse,
  type PitcherSeasonStats,
  type TeamBattingStats,
  type TeamPitchingStats,
} from "./types";
import { parseInningsPitched, parseStatNumber } from "./numeric";

/** Thrown when a stats payload is structurally invalid (fail loudly). */
export class StatsParseError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "StatsParseError";
    this.issues = issues;
  }
}

function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

type RawGroups = { group?: { displayName: string }; splits: { season?: string; stat: Record<string, unknown> }[] }[];

/** Pick the split for a stat group, preferring the requested season. */
function pickSplit(
  groups: RawGroups | undefined,
  groupName: string,
  season: string,
): Record<string, unknown> | null {
  if (!groups) return null;
  const group = groups.find((g) => g.group?.displayName === groupName);
  if (!group || group.splits.length === 0) return null;
  const match = group.splits.find((s) => s.season === season);
  return (match ?? group.splits[0]).stat;
}

/**
 * Record `unsourced:<field>` for every field that came back `null`. This is the
 * "flag, never fake" trail: downstream can see exactly which inputs are soft.
 */
function flagNulls(record: Record<string, number | null>, flags: string[]): void {
  for (const [key, value] of Object.entries(record)) {
    if (value === null) flags.push(`unsourced:${key}`);
  }
}

export function parsePitcherSeasonStats(
  raw: unknown,
  options: { season: string },
): PitcherSeasonStats {
  const result = RawPeopleStatsResponse.safeParse(raw);
  if (!result.success) {
    throw new StatsParseError("people-stats payload did not match expected shape", issuesOf(result.error));
  }
  const person = result.data.people[0];
  if (!person) {
    throw new StatsParseError("people-stats payload contained no people", ["people: empty"]);
  }

  const flags: string[] = [];
  const stat = pickSplit(person.stats, "pitching", options.season);
  if (stat === null) {
    flags.push("no_stats:pitching");
  }

  const numeric = {
    era: parseStatNumber(stat?.["era"]),
    whip: parseStatNumber(stat?.["whip"]),
    strikeoutsPer9: parseStatNumber(stat?.["strikeOutsPer9Inn"]),
    gamesStarted: parseStatNumber(stat?.["gamesStarted"]),
  };
  const inningsPitched = parseInningsPitched(stat?.["inningsPitched"]);
  flagNulls({ ...numeric, inningsPitched }, flags);

  return {
    playerId: person.id,
    fullName: person.fullName,
    season: options.season,
    ...numeric,
    inningsPitched,
    dataFlags: flags,
  };
}

function parseTeamStatsResponse(raw: unknown): RawTeamStatsResponse {
  const result = RawTeamStatsResponse.safeParse(raw);
  if (!result.success) {
    throw new StatsParseError("team-stats payload did not match expected shape", issuesOf(result.error));
  }
  return result.data;
}

export function parseTeamBattingStats(
  raw: unknown,
  options: { season: string; teamId: number; teamName: string },
): TeamBattingStats {
  const data = parseTeamStatsResponse(raw);
  const flags: string[] = [];
  const group = data.stats.find((g) => g.group?.displayName === "hitting");
  const split = group?.splits.find((s) => s.season === options.season) ?? group?.splits[0];
  const stat = split?.stat;
  if (!stat) flags.push("no_stats:hitting");

  const numeric = {
    runs: parseStatNumber(stat?.["runs"]),
    obp: parseStatNumber(stat?.["obp"]),
    slg: parseStatNumber(stat?.["slg"]),
    ops: parseStatNumber(stat?.["ops"]),
    avg: parseStatNumber(stat?.["avg"]),
  };
  flagNulls(numeric, flags);
  // wOBA is never in the free API hitting object — always unsourced for now.
  flags.push("unsourced:woba");

  return {
    teamId: split?.team?.id ?? options.teamId,
    teamName: split?.team?.name ?? options.teamName,
    season: options.season,
    ...numeric,
    woba: null,
    dataFlags: flags,
  };
}

export function parseTeamPitchingStats(
  raw: unknown,
  options: { season: string; teamId: number; teamName: string },
): TeamPitchingStats {
  const data = parseTeamStatsResponse(raw);
  const flags: string[] = [];
  const group = data.stats.find((g) => g.group?.displayName === "pitching");
  const split = group?.splits.find((s) => s.season === options.season) ?? group?.splits[0];
  const stat = split?.stat;
  if (!stat) flags.push("no_stats:pitching");

  const numeric = {
    era: parseStatNumber(stat?.["era"]),
    whip: parseStatNumber(stat?.["whip"]),
    strikeoutsPer9: parseStatNumber(stat?.["strikeOutsPer9Inn"]),
    saves: parseStatNumber(stat?.["saves"]),
  };
  const inningsPitched = parseInningsPitched(stat?.["inningsPitched"]);
  flagNulls({ ...numeric, inningsPitched }, flags);
  // Team-level numbers standing in for a bullpen-only view.
  flags.push("proxy:team_pitching_for_bullpen");

  return {
    teamId: split?.team?.id ?? options.teamId,
    teamName: split?.team?.name ?? options.teamName,
    season: options.season,
    ...numeric,
    inningsPitched,
    bullpenSpecific: false,
    recentWorkload: null,
    dataFlags: flags,
  };
}
