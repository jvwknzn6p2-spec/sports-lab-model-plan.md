/**
 * Steps 1–2 — Fetch the schedule and core game data from the MLB Stats API.
 *
 * This is the layer that finally makes the pipeline run on real games: it
 * fills the `CoreGame` contract the rest of the library was built against.
 *
 * Everything here follows the plan's data principles (Section 3):
 *
 *   - **Fail loudly, not silently.** A stat the API does not return becomes
 *     `null`, never a substituted average. The validation layer then flags it
 *     and caps confidence — which is exactly what those flags exist for.
 *   - **Timestamp everything.** Every derived record carries `fetchedAt`.
 *   - **A single game's failure is not the slate's failure.** One unparseable
 *     game is reported and skipped; the rest of the card still ships.
 */
import type {
  BullpenStats,
  CoreGame,
  GameResult,
  StartingPitcher,
  TeamBattingStats,
  TeamRecentForm,
  TeamRef,
} from "../../schemas";
import { computeRecentForm } from "../../context/recent-form";
import { MlbClient, MlbApiError } from "./client";
import {
  firstSplitStat,
  parseInningsPitched,
  parseStatNumber,
  scheduleResponseSchema,
  statsResponseSchema,
  teamsResponseSchema,
  type ScheduleGame,
} from "./responses";

/** Regular season. The model is not calibrated for spring or postseason. */
const REGULAR_SEASON = "R";

/** Add `days` to a `YYYY-MM-DD` date string, in UTC. */
export function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`Invalid date: ${date}`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Season year implied by a `YYYY-MM-DD` date. */
export function seasonForDate(date: string): number {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) throw new RangeError(`Invalid date: ${date}`);
  return year;
}

/* -------------------------------------------------------------------------- */
/* Team reference data                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Map team id → abbreviation.
 *
 * The schedule endpoint does not reliably include abbreviations, and the
 * ballpark-factor table is keyed by them, so this is fetched once per slate
 * rather than per game.
 */
export async function fetchTeamAbbreviations(
  client: MlbClient,
  season: number,
): Promise<Map<number, string>> {
  const response = await client.get("/teams", { sportId: 1, season }, teamsResponseSchema);
  const map = new Map<number, string>();
  for (const team of response.teams) {
    if (team.abbreviation !== undefined) map.set(team.id, team.abbreviation);
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Schedule                                                                    */
/* -------------------------------------------------------------------------- */

/** Raw schedule games for a date. `gameType` defaults to regular season. */
export async function fetchSchedule(
  client: MlbClient,
  date: string,
  options: { gameType?: string; teamId?: number } = {},
): Promise<ScheduleGame[]> {
  const response = await client.get(
    "/schedule",
    {
      sportId: 1,
      date,
      gameType: options.gameType ?? REGULAR_SEASON,
      teamId: options.teamId,
      hydrate: "probablePitcher,team,venue",
    },
    scheduleResponseSchema,
  );
  return response.dates.flatMap((d) => d.games);
}

/* -------------------------------------------------------------------------- */
/* Per-entity stats                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Season pitching line for one pitcher.
 *
 * `inningsPitched` is decoded from baseball notation — `"120.1"` is 120⅓
 * innings, not 120.1 (see `responses.ts`).
 */
export async function fetchStartingPitcher(
  client: MlbClient,
  personId: number,
  name: string,
  season: number,
  confirmed: boolean,
): Promise<StartingPitcher> {
  const response = await client.get(
    `/people/${personId}/stats`,
    { stats: "season", group: "pitching", season, gameType: REGULAR_SEASON },
    statsResponseSchema,
  );
  const stat = firstSplitStat(response, "pitching") ?? {};

  return {
    playerId: String(personId),
    name,
    confirmed,
    seasonEra: parseStatNumber(stat.era),
    seasonWhip: parseStatNumber(stat.whip),
    inningsPitched: parseInningsPitched(stat.inningsPitched),
  };
}

/**
 * Season team batting.
 *
 * The API reports totals, so runs-per-game is derived from `runs / gamesPlayed`
 * — and only when both are present. A team with zero games played yields null
 * rather than a divide-by-zero, and the baseline model then refuses to price
 * the game at all, which is the correct outcome on opening day.
 */
export async function fetchTeamBatting(
  client: MlbClient,
  teamId: number,
  season: number,
  fetchedAt: string,
): Promise<TeamBattingStats> {
  const response = await client.get(
    `/teams/${teamId}/stats`,
    { stats: "season", group: "hitting", season, gameType: REGULAR_SEASON },
    statsResponseSchema,
  );
  const stat = firstSplitStat(response, "hitting") ?? {};

  const runs = parseStatNumber(stat.runs);
  const games = parseStatNumber(stat.gamesPlayed);

  return {
    teamId: String(teamId),
    runsPerGame: runs !== null && games !== null && games > 0 ? runs / games : null,
    onBasePct: parseStatNumber(stat.obp),
    sluggingPct: parseStatNumber(stat.slg),
    // The MLB Stats API does not publish wOBA; left null rather than approximated.
    wOBA: null,
    fetchedAt,
  };
}

/**
 * Bullpen ERA, via the relief-pitching situational split (`sitCodes=rp`).
 *
 * If that split is unavailable the ERA is left null rather than substituting
 * the team's overall pitching ERA — which would fold the rotation into the
 * bullpen number and quietly flatter or damage every late-innings estimate.
 * The validation layer raises `missing_bullpen` and caps confidence at B.
 *
 * `inningsPitchedLast3Days` is **not** populated: recent bullpen workload needs
 * per-reliever game logs, which is a separate ingest. Null means the baseline
 * skips its fatigue adjustment rather than assuming a rested pen.
 */
export async function fetchBullpen(
  client: MlbClient,
  teamId: number,
  season: number,
  fetchedAt: string,
): Promise<BullpenStats> {
  let era: number | null = null;
  try {
    const response = await client.get(
      `/teams/${teamId}/stats`,
      { stats: "statSplits", group: "pitching", sitCodes: "rp", season, gameType: REGULAR_SEASON },
      statsResponseSchema,
    );
    era = parseStatNumber(firstSplitStat(response, "pitching")?.era);
  } catch (error) {
    // A split this endpoint declines to serve is a missing input, not a slate
    // failure — flag it downstream rather than dropping the game.
    if (!(error instanceof MlbApiError)) throw error;
  }

  return {
    teamId: String(teamId),
    era,
    inningsPitchedLast3Days: null,
    fetchedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Recent form                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Recent form for one team, from completed games before `date`.
 *
 * Looks back over a wider calendar window than `window` games, because off
 * days mean N games span more than N days.
 */
export async function fetchRecentForm(
  client: MlbClient,
  teamId: number,
  date: string,
  fetchedAt: string,
  options: { window?: number; lookbackDays?: number } = {},
): Promise<TeamRecentForm> {
  const window = options.window ?? 10;
  const lookbackDays = options.lookbackDays ?? window * 3;

  const response = await client.get(
    "/schedule",
    {
      sportId: 1,
      teamId,
      startDate: shiftDate(date, -lookbackDays),
      endDate: shiftDate(date, -1),
      gameType: REGULAR_SEASON,
    },
    scheduleResponseSchema,
  );

  const results: GameResult[] = [];
  for (const day of response.dates) {
    for (const game of day.games) {
      if (game.status.abstractGameState !== "Final") continue;
      const isHome = game.teams.home.team.id === teamId;
      const mine = isHome ? game.teams.home : game.teams.away;
      const theirs = isHome ? game.teams.away : game.teams.home;
      if (mine.score === undefined || theirs.score === undefined) continue;

      results.push({
        date: new Date(game.gameDate).toISOString(),
        won: mine.score > theirs.score,
        runsScored: mine.score,
        runsAllowed: theirs.score,
      });
    }
  }

  return computeRecentForm(String(teamId), results, window, fetchedAt);
}

/* -------------------------------------------------------------------------- */
/* Slate assembly                                                             */
/* -------------------------------------------------------------------------- */

export interface FetchCoreGamesOptions {
  /** Reference timestamp stamped on every derived record. Defaults to now. */
  fetchedAt?: string;
  /**
   * Treat an announced probable pitcher as confirmed.
   *
   * Off by default, and deliberately so: MLB's "probable pitcher" is exactly
   * that — probable. A club can scratch a starter after announcing one, and
   * the API carries no confirmation flag. Left false, the validation layer
   * raises `unconfirmed_starter` and caps the game at A, which is the honest
   * position for a morning run. Set true only when you have separately
   * verified the posted lineup.
   */
  treatProbableAsConfirmed?: boolean;
  /** Restrict to one team, for testing or single-game runs. */
  teamId?: number;
}

export interface FetchCoreGamesResult {
  date: string;
  games: CoreGame[];
  /** Games on the schedule that could not be assembled, and why. */
  failures: { gamePk: number; message: string }[];
}

function toTeamRef(
  team: { id: number; name: string; abbreviation?: string },
  abbreviations: Map<number, string>,
): TeamRef {
  // Fall back to a truncated name so the ref stays valid; the ballpark lookup
  // will then miss and be flagged as a neutral fallback rather than silently
  // matching the wrong park.
  const abbreviation = team.abbreviation ?? abbreviations.get(team.id) ?? team.name.slice(0, 3).toUpperCase();
  return { id: String(team.id), name: team.name, abbreviation };
}

/**
 * Fetch a full day's slate as `CoreGame` records — the Steps 1–2 deliverable.
 *
 * Games missing a venue or a team are reported in `failures` rather than
 * throwing, so one malformed entry cannot cost you the rest of the card.
 */
export async function fetchCoreGames(
  client: MlbClient,
  date: string,
  options: FetchCoreGamesOptions = {},
): Promise<FetchCoreGamesResult> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const season = seasonForDate(date);
  const confirmed = options.treatProbableAsConfirmed ?? false;

  const [schedule, abbreviations] = await Promise.all([
    fetchSchedule(client, date, { teamId: options.teamId }),
    fetchTeamAbbreviations(client, season).catch(() => new Map<number, string>()),
  ]);

  const games: CoreGame[] = [];
  const failures: FetchCoreGamesResult["failures"] = [];

  for (const game of schedule) {
    try {
      if (game.venue === undefined) throw new Error("schedule entry has no venue");

      const home = toTeamRef(game.teams.home.team, abbreviations);
      const away = toTeamRef(game.teams.away.team, abbreviations);

      const [homeStarter, awayStarter, homeBatting, awayBatting, homeBullpen, awayBullpen] =
        await Promise.all([
          game.teams.home.probablePitcher === undefined
            ? Promise.resolve(null)
            : fetchStartingPitcher(
                client,
                game.teams.home.probablePitcher.id,
                game.teams.home.probablePitcher.fullName,
                season,
                confirmed,
              ),
          game.teams.away.probablePitcher === undefined
            ? Promise.resolve(null)
            : fetchStartingPitcher(
                client,
                game.teams.away.probablePitcher.id,
                game.teams.away.probablePitcher.fullName,
                season,
                confirmed,
              ),
          fetchTeamBatting(client, game.teams.home.team.id, season, fetchedAt),
          fetchTeamBatting(client, game.teams.away.team.id, season, fetchedAt),
          fetchBullpen(client, game.teams.home.team.id, season, fetchedAt),
          fetchBullpen(client, game.teams.away.team.id, season, fetchedAt),
        ]);

      games.push({
        gameId: String(game.gamePk),
        startTime: new Date(game.gameDate).toISOString(),
        venueId: String(game.venue.id),
        venueName: game.venue.name,
        home,
        away,
        homeStarter,
        awayStarter,
        homeBatting,
        awayBatting,
        homeBullpen,
        awayBullpen,
      });
    } catch (error) {
      failures.push({
        gamePk: game.gamePk,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { date, games, failures };
}
