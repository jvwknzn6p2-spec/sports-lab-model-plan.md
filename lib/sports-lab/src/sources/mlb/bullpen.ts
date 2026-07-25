/**
 * Bullpen quality.
 *
 * MLB does not publish a "bullpen ERA" endpoint, so we build one: pull every
 * pitcher's season line league-wide (a handful of paged calls, cached for the
 * day) and aggregate the pure relievers — pitchers with zero starts — per team.
 *
 * Known approximation: swingmen who both start and relieve are excluded rather
 * than split. That biases the sample toward dedicated relievers, which is the
 * right direction for "who pitches the 7th, 8th and 9th", but it is an
 * approximation and it is flagged as one when the reliever count is thin.
 */

import { SOURCE_URLS } from "../../config";
import type { BullpenProfile, TeamRef } from "../../core/types";
import type { HttpClient } from "../http";
import { parseInningsPitched, per9, statNumber, statsEnvelopeSchema } from "./parse";

const PAGE_SIZE = 250;
const MAX_PAGES = 8;
/** Below this many qualifying relievers, treat the aggregate as unreliable. */
export const MIN_RELIEVERS = 5;

interface Aggregate {
  team: TeamRef;
  innings: number;
  runs: number;
  pitchers: number;
}

export class MlbBullpenSource {
  private byTeam: Map<number, Aggregate> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly season: number,
  ) {}

  private async load(): Promise<Map<number, Aggregate>> {
    if (this.byTeam) return this.byTeam;
    const aggregates = new Map<number, Aggregate>();

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const outcome = await this.http.getJson<unknown>(`${SOURCE_URLS.mlbStatsApi}/stats`, {
        cacheKey: `mlb/pitcher-pool/${this.season}-${offset}`,
        label: `MLB league pitching pool ${this.season} (offset ${offset})`,
        query: {
          stats: "season",
          group: "pitching",
          season: this.season,
          sportId: 1,
          gameType: "R",
          playerPool: "All",
          limit: PAGE_SIZE,
          offset,
        },
      });
      const parsed = statsEnvelopeSchema.safeParse(outcome.body);
      if (!parsed.success) break;
      const splits = (parsed.data.stats ?? []).flatMap((group) => group.splits ?? []);
      if (splits.length === 0) break;

      for (const split of splits) {
        const teamNode = split.team;
        const stat = split.stat;
        if (!teamNode || teamNode.id === undefined || !stat) continue;
        const gamesStarted = statNumber(stat["gamesStarted"]) ?? 0;
        const gamesPitched = statNumber(stat["gamesPlayed"]) ?? statNumber(stat["games"]) ?? 0;
        if (gamesStarted > 0 || gamesPitched <= 0) continue;
        const innings = parseInningsPitched(stat["inningsPitched"]);
        const runs = statNumber(stat["runs"]);
        if (innings === null || innings <= 0 || runs === null) continue;

        const existing = aggregates.get(teamNode.id) ?? {
          team: {
            id: teamNode.id,
            name: teamNode.name ?? `Team ${teamNode.id}`,
            abbrev: teamNode.abbreviation ?? "???",
          },
          innings: 0,
          runs: 0,
          pitchers: 0,
        };
        existing.innings += innings;
        existing.runs += runs;
        existing.pitchers += 1;
        aggregates.set(teamNode.id, existing);
      }
      if (splits.length < PAGE_SIZE) break;
    }

    this.byTeam = aggregates;
    return aggregates;
  }

  /**
   * @param fatigueIndex 0..1 workload proxy from recent schedule density, or
   *   null when recent history is unavailable.
   */
  async profile(team: TeamRef, fatigueIndex: number | null): Promise<BullpenProfile | null> {
    const aggregates = await this.load();
    const entry = aggregates.get(team.id);
    if (!entry) return null;
    return {
      team,
      season: this.season,
      runsAllowedPer9: per9(entry.runs, entry.innings),
      reliefInningsPitched: entry.innings,
      pitcherCount: entry.pitchers,
      fatigueIndex,
    };
  }
}

/**
 * Bullpen workload proxy in 0..1 from schedule density.
 *
 * A team plays roughly 2.6 games in any 3-day window. More games than that —
 * or extra-inning games, which burn multiple relievers — means a more tired
 * bullpen. This is a proxy, not measured relief innings: it does not know that
 * yesterday's starter threw a complete game.
 */
export function fatigueFromSchedule(
  gamesLast3Days: number,
  extraInningGamesLast3Days: number,
): number {
  const load = gamesLast3Days + 0.5 * extraInningGamesLast3Days;
  const normal = 2.4;
  const span = 1.6;
  return Math.min(1, Math.max(0, (load - normal) / span));
}
