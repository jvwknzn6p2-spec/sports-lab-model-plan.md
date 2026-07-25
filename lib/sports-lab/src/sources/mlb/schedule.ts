/**
 * Step 1 of the plan: the schedule fetch — plus everything else we can derive
 * cheaply from daily schedule pulls (final scores, recent form, bullpen load).
 *
 * One schedule call per date, cached, serves four purposes. That keeps the
 * daily run well inside any rate limit while still giving the model real
 * recent-form and workload inputs.
 */

import { SOURCE_URLS } from "../../config";
import type { GameDate, GameResult, ScheduledGame, TeamRef } from "../../core/types";
import { assertGameDate, addDays } from "../../core/dates";
import type { HttpClient } from "../http";
import {
  deriveAbbrev,
  scheduleEnvelopeSchema,
  type ScheduleGameNode,
} from "./parse";

/** Regular season only for v1.0. Spring training and exhibitions are excluded. */
const DEFAULT_GAME_TYPES = new Set(["R"]);

/** Postseason codes, accepted when the caller opts in. */
export const POSTSEASON_GAME_TYPES = ["F", "D", "L", "W", "P"] as const;

export interface DaySchedule {
  date: GameDate;
  games: ScheduleGameNode[];
  fetchedAt: string;
  origin: "network" | "cache" | "fixture";
}

function toTeamRef(node: { id?: number; name?: string; abbreviation?: string } | undefined): TeamRef | null {
  if (!node || node.id === undefined) return null;
  const name = node.name ?? `Team ${node.id}`;
  return { id: node.id, name, abbrev: node.abbreviation ?? deriveAbbrev(name) };
}

export class MlbScheduleSource {
  private readonly dayCache = new Map<GameDate, DaySchedule>();

  constructor(
    private readonly http: HttpClient,
    private readonly gameTypes: Set<string> = DEFAULT_GAME_TYPES,
  ) {}

  /**
   * Raw schedule for one date. Hydrated with probable pitchers and linescore so
   * the same response answers "who pitches today" and "what happened
   * yesterday".
   */
  async fetchDay(date: GameDate, ttlSeconds?: number): Promise<DaySchedule> {
    assertGameDate(date);
    const cached = this.dayCache.get(date);
    if (cached) return cached;

    const outcome = await this.http.getJson<unknown>(`${SOURCE_URLS.mlbStatsApi}/schedule`, {
      cacheKey: `mlb/schedule/${date}`,
      label: `MLB schedule ${date}`,
      ttlSeconds,
      query: {
        sportId: 1,
        date,
        hydrate: "probablePitcher,linescore,team",
      },
    });

    const parsed = scheduleEnvelopeSchema.safeParse(outcome.body);
    if (!parsed.success) {
      throw new Error(
        `MLB schedule ${date}: unexpected response shape — ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    const games: ScheduleGameNode[] = [];
    for (const day of parsed.data.dates ?? []) {
      for (const game of day.games ?? []) {
        const type = game.gameType ?? "R";
        if (!this.gameTypes.has(type)) continue;
        games.push(game);
      }
    }

    const day: DaySchedule = {
      date,
      games,
      fetchedAt: outcome.fetchedAt,
      origin: outcome.origin,
    };
    this.dayCache.set(date, day);
    return day;
  }

  /** Games to predict for `date`, in start-time order. */
  async scheduledGames(date: GameDate): Promise<{ games: ScheduledGame[]; fetchedAt: string }> {
    // Short TTL: probable pitchers get announced and changed through the day.
    const day = await this.fetchDay(date, 30 * 60);
    const games: ScheduledGame[] = [];
    for (const node of day.games) {
      const home = toTeamRef(node.teams.home?.team);
      const away = toTeamRef(node.teams.away?.team);
      if (!home || !away) continue;
      const probableHome = node.teams.home?.probablePitcher;
      const probableAway = node.teams.away?.probablePitcher;
      games.push({
        sport: "MLB",
        gamePk: node.gamePk,
        date: node.officialDate ?? date,
        gameTimeUtc: node.gameDate ?? "",
        status: node.status?.detailedState ?? "Unknown",
        abstractState: node.status?.abstractGameState ?? "Unknown",
        home,
        away,
        venue: {
          id: node.venue?.id ?? 0,
          name: node.venue?.name ?? "Unknown venue",
        },
        probablePitchers: {
          home:
            probableHome?.id === undefined
              ? null
              : {
                  id: probableHome.id,
                  fullName: probableHome.fullName ?? `Pitcher ${probableHome.id}`,
                  throws: probableHome.pitchHand?.code ?? null,
                },
          away:
            probableAway?.id === undefined
              ? null
              : {
                  id: probableAway.id,
                  fullName: probableAway.fullName ?? `Pitcher ${probableAway.id}`,
                  throws: probableAway.pitchHand?.code ?? null,
                },
        },
        doubleHeader: node.doubleHeader ?? null,
      });
    }
    games.sort((a, b) => a.gameTimeUtc.localeCompare(b.gameTimeUtc) || a.gamePk - b.gamePk);
    return { games, fetchedAt: day.fetchedAt };
  }

  /** Final scores for `date`. Games not yet final are omitted. */
  async results(date: GameDate): Promise<GameResult[]> {
    // Results are immutable once final, but a same-day call may see live games,
    // so keep the TTL short enough to pick up the finals.
    const day = await this.fetchDay(date, 15 * 60);
    const results: GameResult[] = [];
    for (const node of day.games) {
      const abstract = node.status?.abstractGameState;
      if (abstract !== "Final") continue;
      const homeScore = node.teams.home?.score ?? node.linescore?.teams?.home?.runs;
      const awayScore = node.teams.away?.score ?? node.linescore?.teams?.away?.runs;
      if (homeScore === undefined || awayScore === undefined) continue;
      const scheduledInnings = node.linescore?.scheduledInnings ?? 9;
      const innings = node.linescore?.currentInning ?? scheduledInnings;
      results.push({
        sport: "MLB",
        gamePk: node.gamePk,
        date: node.officialDate ?? date,
        status: node.status?.detailedState ?? "Final",
        homeScore,
        awayScore,
        innings,
        wentToExtras: innings > scheduledInnings,
        fetchedAt: day.fetchedAt,
      });
    }
    return results;
  }

  /**
   * Team-level recent form and bullpen workload from the `days` dates before
   * `date`. Only completed games count.
   */
  async recentTeamHistory(
    date: GameDate,
    days: number,
  ): Promise<Map<number, TeamHistory>> {
    const history = new Map<number, TeamHistory>();
    const ensure = (team: TeamRef): TeamHistory => {
      const existing = history.get(team.id);
      if (existing) return existing;
      const created: TeamHistory = {
        team,
        games: 0,
        runsScored: 0,
        runsAllowed: 0,
        gamesLast3Days: 0,
        extraInningGamesLast3Days: 0,
      };
      history.set(team.id, created);
      return created;
    };

    for (let back = 1; back <= days; back++) {
      const day = addDays(date, -back);
      let results: GameResult[];
      let nodes: ScheduleGameNode[];
      try {
        const schedule = await this.fetchDay(day, 24 * 60 * 60);
        nodes = schedule.games;
        results = await this.results(day);
      } catch {
        // A single unavailable historical date must not sink today's slate.
        continue;
      }
      const resultByPk = new Map(results.map((r) => [r.gamePk, r]));
      for (const node of nodes) {
        const result = resultByPk.get(node.gamePk);
        if (!result) continue;
        const home = toTeamRef(node.teams.home?.team);
        const away = toTeamRef(node.teams.away?.team);
        if (!home || !away) continue;
        const homeEntry = ensure(home);
        const awayEntry = ensure(away);
        homeEntry.games += 1;
        homeEntry.runsScored += result.homeScore;
        homeEntry.runsAllowed += result.awayScore;
        awayEntry.games += 1;
        awayEntry.runsScored += result.awayScore;
        awayEntry.runsAllowed += result.homeScore;
        if (back <= 3) {
          homeEntry.gamesLast3Days += 1;
          awayEntry.gamesLast3Days += 1;
          if (result.wentToExtras) {
            homeEntry.extraInningGamesLast3Days += 1;
            awayEntry.extraInningGamesLast3Days += 1;
          }
        }
      }
    }
    return history;
  }
}

export interface TeamHistory {
  team: TeamRef;
  games: number;
  runsScored: number;
  runsAllowed: number;
  gamesLast3Days: number;
  extraInningGamesLast3Days: number;
}
