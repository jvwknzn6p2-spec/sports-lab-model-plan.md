import { type ScheduledGame, type TeamSide } from "../schedule/types";
import { type FetchLike } from "../schedule/fetch";
import {
  fetchPitcherSeasonStats,
  fetchTeamBattingStats,
  fetchTeamPitchingStats,
} from "./fetch";
import {
  type GameStatBundle,
  type PitcherSeasonStats,
  type TeamBattingStats,
  type TeamPitchingStats,
  type TeamStatSide,
} from "./types";

export interface AssembleGameStatsOptions {
  season: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  signal?: AbortSignal;
  /** Override the assembly timestamp (deterministic tests). */
  assembledAtUtc?: string;
}

function prefixFlags(prefix: string, flags: string[]): string[] {
  return flags.map((f) => `${prefix}.${f}`);
}

async function assembleSide(
  side: TeamSide,
  options: AssembleGameStatsOptions,
): Promise<{ side: TeamStatSide; flags: string[] }> {
  const fetchOpts = {
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
    signal: options.signal,
  };

  const [batting, pitchingStaff, probableStarter]: [
    TeamBattingStats,
    TeamPitchingStats,
    PitcherSeasonStats | null,
  ] = await Promise.all([
    fetchTeamBattingStats(side.teamId, side.teamName, options.season, fetchOpts),
    fetchTeamPitchingStats(side.teamId, side.teamName, options.season, fetchOpts),
    side.probablePitcher
      ? fetchPitcherSeasonStats(side.probablePitcher.id, options.season, fetchOpts)
      : Promise.resolve(null),
  ]);

  const flags = [
    ...prefixFlags("batting", batting.dataFlags),
    ...prefixFlags("pitchingStaff", pitchingStaff.dataFlags),
    ...(probableStarter ? prefixFlags("probableStarter", probableStarter.dataFlags) : []),
  ];

  return {
    side: {
      teamId: side.teamId,
      teamName: side.teamName,
      batting,
      pitchingStaff,
      probableStarter,
    },
    flags,
  };
}

/**
 * Assemble the Step-2 core game data for a scheduled game: both teams' batting
 * and (proxy) bullpen/pitching stats, plus each confirmed starter's season
 * line. Fetches are injectable and run concurrently per side.
 *
 * `dataFlags` aggregates the schedule-level flags (prefixed `schedule.`) with
 * each stat component's flags (prefixed `home.`/`away.` then component), so a
 * single glance shows every soft input feeding this game.
 */
export async function assembleGameStats(
  game: ScheduledGame,
  options: AssembleGameStatsOptions,
): Promise<GameStatBundle> {
  const [home, away] = await Promise.all([
    assembleSide(game.home, options),
    assembleSide(game.away, options),
  ]);

  const dataFlags = [
    ...prefixFlags("schedule", game.dataFlags),
    ...prefixFlags("home", home.flags),
    ...prefixFlags("away", away.flags),
  ];

  return {
    gamePk: game.gamePk,
    season: options.season,
    assembledAtUtc: options.assembledAtUtc ?? new Date().toISOString(),
    home: home.side,
    away: away.side,
    dataFlags,
  };
}
