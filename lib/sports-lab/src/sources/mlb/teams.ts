/**
 * Step 2 of the plan: team batting and pitching.
 *
 * The league-wide endpoint returns all 30 teams in a single call, so a full
 * slate costs two requests (hitting + pitching) instead of sixty. A per-team
 * fallback covers the case where the league-wide call comes back empty.
 */

import { SOURCE_URLS } from "../../config";
import type { TeamOffense, TeamPitching, TeamRef } from "../../core/types";
import type { HttpClient } from "../http";
import {
  deriveAbbrev,
  parseInningsPitched,
  per9,
  rosterEnvelopeSchema,
  statNumber,
  statsEnvelopeSchema,
  type StatSplit,
} from "./parse";

/** Injured-list status codes on the 40-man roster. */
const INJURED_STATUS_CODES = new Set([
  "D7",
  "D10",
  "D15",
  "D60",
  "DL",
  "IL",
  "BRV",
  "PL",
  "SU",
  "RES",
]);

function splitsOf(body: unknown): StatSplit[] {
  const parsed = statsEnvelopeSchema.safeParse(body);
  if (!parsed.success) return [];
  const splits: StatSplit[] = [];
  for (const group of parsed.data.stats ?? []) {
    for (const split of group.splits ?? []) splits.push(split);
  }
  return splits;
}

function teamRefFromSplit(split: StatSplit): TeamRef | null {
  const node = split.team;
  if (!node || node.id === undefined) return null;
  const name = node.name ?? `Team ${node.id}`;
  return { id: node.id, name, abbrev: node.abbreviation ?? deriveAbbrev(name) };
}

function toOffense(split: StatSplit, season: number, fallbackTeam?: TeamRef): TeamOffense | null {
  const team = teamRefFromSplit(split) ?? fallbackTeam ?? null;
  const stat = split.stat;
  if (!team || !stat) return null;
  const gamesPlayed = statNumber(stat["gamesPlayed"]) ?? 0;
  const runs = statNumber(stat["runs"]) ?? 0;
  const plateAppearances = statNumber(stat["plateAppearances"]) ?? 0;
  return {
    team,
    season,
    gamesPlayed,
    runs,
    plateAppearances,
    onBasePct: statNumber(stat["obp"]),
    sluggingPct: statNumber(stat["slg"]),
    runsPerGame: gamesPlayed > 0 ? runs / gamesPlayed : null,
  };
}

function toPitching(split: StatSplit, season: number, fallbackTeam?: TeamRef): TeamPitching | null {
  const team = teamRefFromSplit(split) ?? fallbackTeam ?? null;
  const stat = split.stat;
  if (!team || !stat) return null;
  const innings = parseInningsPitched(stat["inningsPitched"]) ?? 0;
  const runs = statNumber(stat["runs"]);
  return {
    team,
    season,
    inningsPitched: innings,
    runsAllowedPer9: per9(runs, innings > 0 ? innings : null),
  };
}

export class MlbTeamStatsSource {
  private offenseByTeam: Map<number, TeamOffense> | null = null;
  private pitchingByTeam: Map<number, TeamPitching> | null = null;
  private readonly injuriesByTeam = new Map<number, string[]>();

  constructor(
    private readonly http: HttpClient,
    private readonly season: number,
  ) {}

  private async loadLeague(group: "hitting" | "pitching"): Promise<StatSplit[]> {
    const outcome = await this.http.getJson<unknown>(`${SOURCE_URLS.mlbStatsApi}/teams/stats`, {
      cacheKey: `mlb/team-stats/${this.season}-${group}`,
      label: `MLB team ${group} stats ${this.season}`,
      query: {
        stats: "season",
        group,
        season: this.season,
        sportIds: 1,
        gameType: "R",
      },
    });
    return splitsOf(outcome.body);
  }

  private async loadTeam(
    teamId: number,
    group: "hitting" | "pitching",
  ): Promise<StatSplit[]> {
    const outcome = await this.http.getJson<unknown>(
      `${SOURCE_URLS.mlbStatsApi}/teams/${teamId}/stats`,
      {
        cacheKey: `mlb/team-stats/${this.season}-${group}-${teamId}`,
        label: `MLB team ${group} stats ${this.season} team ${teamId}`,
        query: { stats: "season", group, season: this.season, gameType: "R" },
      },
    );
    return splitsOf(outcome.body);
  }

  /** Season batting line, or null when the team has no usable split. */
  async offense(team: TeamRef): Promise<TeamOffense | null> {
    if (!this.offenseByTeam) {
      const splits = await this.loadLeague("hitting");
      this.offenseByTeam = new Map();
      for (const split of splits) {
        const offense = toOffense(split, this.season);
        if (offense) this.offenseByTeam.set(offense.team.id, offense);
      }
    }
    const cached = this.offenseByTeam.get(team.id);
    if (cached) return cached;

    const splits = await this.loadTeam(team.id, "hitting");
    for (const split of splits) {
      const offense = toOffense(split, this.season, team);
      if (offense) {
        this.offenseByTeam.set(team.id, offense);
        return offense;
      }
    }
    return null;
  }

  /** Season team pitching line (all pitchers), or null. */
  async pitching(team: TeamRef): Promise<TeamPitching | null> {
    if (!this.pitchingByTeam) {
      const splits = await this.loadLeague("pitching");
      this.pitchingByTeam = new Map();
      for (const split of splits) {
        const pitching = toPitching(split, this.season);
        if (pitching) this.pitchingByTeam.set(pitching.team.id, pitching);
      }
    }
    const cached = this.pitchingByTeam.get(team.id);
    if (cached) return cached;

    const splits = await this.loadTeam(team.id, "pitching");
    for (const split of splits) {
      const pitching = toPitching(split, this.season, team);
      if (pitching) {
        this.pitchingByTeam.set(team.id, pitching);
        return pitching;
      }
    }
    return null;
  }

  /**
   * Players on the injured list, from the 40-man roster's status codes.
   *
   * v1.0 counts them; it does not value them. A team missing its best hitter
   * and a team missing its 40th man look the same here, which is exactly why
   * the injury adjustment is capped at a few percent.
   */
  async injuredPlayers(team: TeamRef): Promise<string[] | null> {
    const cached = this.injuriesByTeam.get(team.id);
    if (cached) return cached;
    const outcome = await this.http.getJson<unknown>(
      `${SOURCE_URLS.mlbStatsApi}/teams/${team.id}/roster`,
      {
        cacheKey: `mlb/roster/${this.season}-${team.id}`,
        label: `MLB 40-man roster ${team.name}`,
        ttlSeconds: 6 * 60 * 60,
        query: { rosterType: "40Man", season: this.season },
      },
    );
    const parsed = rosterEnvelopeSchema.safeParse(outcome.body);
    if (!parsed.success || !parsed.data.roster) return null;
    const names: string[] = [];
    for (const entry of parsed.data.roster) {
      const code = entry.status?.code?.toUpperCase();
      if (!code || !INJURED_STATUS_CODES.has(code)) continue;
      names.push(entry.person?.fullName ?? `Player ${entry.person?.id ?? "?"}`);
    }
    this.injuriesByTeam.set(team.id, names);
    return names;
  }
}
