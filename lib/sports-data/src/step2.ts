/**
 * Step 2 orchestrator — "Add core game data".
 *
 * For each scheduled game, assemble the three core inputs the baseline run
 * model needs, all on a FIP/wOBA basis:
 *   - starting-pitcher run prevention (home & away)
 *   - team offense (home & away)
 *   - bullpen run prevention (home & away)
 *
 * The orchestrator is transport-agnostic: it depends on a `CoreDataSource`
 * interface, so it runs identically against the live MLB API, cached pulls, or
 * offline fixtures. It never invents data — every missing input becomes a flag
 * and a lowered confidence, per the plan's "fail loudly" principle.
 */

import {
  buildBullpenFeatures,
  buildStartingPitcherFeatures,
  buildTeamBattingFeatures,
  type BullpenFeatures,
  type BullpenWorkload,
  type DataQualityFlag,
  type StartingPitcherFeatures,
  type TeamBattingFeatures,
} from "./features";
import type { RawBattingLine, RawPitchingLine } from "./sabermetrics";
import type { NormalizedGame } from "./mlb/parse";
import { HIGH_WIND_KMH, type GameWeather } from "./sources/weather";
import type { IlPlayer } from "./sources/injuries-builder";

/** Everything the orchestrator needs, behind one injectable interface. */
export interface CoreDataSource {
  getSchedule(date: string): Promise<NormalizedGame[]>;
  getStarterLine(
    pitcherId: number,
    season: number,
  ): Promise<RawPitchingLine | null>;
  getTeamBattingLine(
    teamId: number,
    season: number,
  ): Promise<RawBattingLine | null>;
  getBullpenLine(
    teamId: number,
    season: number,
  ): Promise<RawPitchingLine | null>;
  /** Optional context; return undefined when not tracked. */
  getBullpenWorkload?(teamId: number): Promise<BullpenWorkload | undefined>;
  /** Optional one-year venue park factor (100 = neutral). */
  getParkFactor?(venueId: number | null): Promise<number | undefined>;
  /** Optional recent form (last-N-games scoring); undefined when untracked. */
  getRecentForm?(teamId: number): Promise<TeamRecentForm | undefined>;
  /** Optional first-pitch weather; undefined when untracked. */
  getWeather?(gamePk: number): Promise<GameWeather | undefined>;
  /** Optional IL list per team; undefined when untracked. */
  getInjuries?(teamId: number): Promise<IlPlayer[] | undefined>;
}

/** A team's scoring over its most recent games (Final games only). */
export interface TeamRecentForm {
  /** Number of games in the sample (target 15; fewer early in a season). */
  games: number;
  runsScoredPerGame: number;
  runsAllowedPerGame: number;
}

export interface TeamCoreData {
  teamId: number | null;
  teamName: string | null;
  starter: StartingPitcherFeatures | null;
  batting: TeamBattingFeatures | null;
  bullpen: BullpenFeatures | null;
  /** Recent form; null = untracked, and the run model applies no adjustment. */
  form: TeamRecentForm | null;
  /**
   * Players on the IL; null = untracked. Informational only — who replaces
   * them is unknown, so no numeric adjustment is ever derived from this.
   */
  ilPlayers: IlPlayer[] | null;
}

export interface GameCoreData {
  gamePk: number;
  gameDate: string | null;
  venue: { id: number | null; name: string | null };
  parkFactor: number;
  /** First-pitch weather; null = untracked, and no adjustment is applied. */
  weather: GameWeather | null;
  home: TeamCoreData;
  away: TeamCoreData;
  flags: DataQualityFlag[];
  /** True when every core input for both teams is present. */
  complete: boolean;
}

export interface AssembleOptions {
  season: number;
}

export async function assembleGameCoreData(
  game: NormalizedGame,
  source: CoreDataSource,
  opts: AssembleOptions,
): Promise<GameCoreData> {
  const { season } = opts;
  const parkFactor =
    (source.getParkFactor
      ? await source.getParkFactor(game.venue.id)
      : undefined) ?? 100;

  const flags: DataQualityFlag[] = [];

  const weather =
    (source.getWeather ? await source.getWeather(game.gamePk) : undefined) ??
    null;
  if (!weather) {
    flags.push({
      code: "weather_missing",
      severity: "info",
      message: "No first-pitch weather — run environment not adjusted.",
    });
  } else if (
    weather.roof === "outdoor" &&
    weather.windSpeedKmh !== null &&
    weather.windSpeedKmh >= HIGH_WIND_KMH
  ) {
    // Direction-blind by design: without park orientation data a wind speed
    // cannot honestly become a run adjustment, but it can and should mark
    // the total as less certain than the simulator's spread claims.
    flags.push({
      code: "weather_high_wind",
      severity: "warn",
      message: `Wind ${weather.windSpeedKmh.toFixed(0)} km/h at an open park — totals less reliable.`,
    });
  }

  const buildSide = async (
    side: NormalizedGame["home"],
    label: "home" | "away",
  ): Promise<TeamCoreData> => {
    let starter: StartingPitcherFeatures | null = null;
    let batting: TeamBattingFeatures | null = null;
    let bullpen: BullpenFeatures | null = null;

    // Starter.
    if (side.probablePitcherId === null) {
      flags.push({
        code: `${label}_no_probable_pitcher`,
        severity: "downgrade",
        message: `${label} team has no confirmed probable starter yet.`,
      });
    } else {
      const line = await source.getStarterLine(side.probablePitcherId, season);
      if (!line) {
        flags.push({
          code: `${label}_starter_stats_missing`,
          severity: "downgrade",
          message: `No season pitching stats for ${label} probable starter.`,
        });
      } else {
        starter = buildStartingPitcherFeatures({
          pitcherId: side.probablePitcherId,
          pitcherName: side.probablePitcherName ?? undefined,
          season,
          line,
          parkFactor,
        });
        promoteFlags(starter.flags, `${label}_starter`, flags);
      }
    }

    // Team batting.
    if (side.teamId !== null) {
      const line = await source.getTeamBattingLine(side.teamId, season);
      if (!line) {
        flags.push({
          code: `${label}_batting_missing`,
          severity: "warn",
          message: `No season batting stats for ${label} team.`,
        });
      } else {
        batting = buildTeamBattingFeatures({
          teamId: side.teamId,
          teamName: side.teamName ?? undefined,
          season,
          line,
        });
        promoteFlags(batting.flags, `${label}_batting`, flags);
      }

      // Bullpen.
      const bpLine = await source.getBullpenLine(side.teamId, season);
      if (!bpLine) {
        flags.push({
          code: `${label}_bullpen_missing`,
          severity: "warn",
          message: `No season bullpen stats for ${label} team.`,
        });
      } else {
        const workload = source.getBullpenWorkload
          ? await source.getBullpenWorkload(side.teamId)
          : undefined;
        bullpen = buildBullpenFeatures({
          teamId: side.teamId,
          teamName: side.teamName ?? undefined,
          season,
          line: bpLine,
          parkFactor,
          workload,
        });
        promoteFlags(bullpen.flags, `${label}_bullpen`, flags);
      }
    }

    const form =
      side.teamId !== null && source.getRecentForm
        ? ((await source.getRecentForm(side.teamId)) ?? null)
        : null;

    const ilPlayers =
      side.teamId !== null && source.getInjuries
        ? ((await source.getInjuries(side.teamId)) ?? null)
        : null;
    if (ilPlayers && ilPlayers.length > 0) {
      flags.push({
        code: `${label}_players_on_il`,
        severity: "info",
        message:
          `${label} team has ${ilPlayers.length} player(s) on the IL: ` +
          ilPlayers
            .map((p) => `${p.name}${p.position ? ` (${p.position})` : ""}`)
            .join(", "),
      });
    }

    return {
      teamId: side.teamId,
      teamName: side.teamName,
      starter,
      batting,
      bullpen,
      form,
      ilPlayers,
    };
  };

  const home = await buildSide(game.home, "home");
  const away = await buildSide(game.away, "away");

  const complete =
    !!home.starter &&
    !!home.batting &&
    !!home.bullpen &&
    !!away.starter &&
    !!away.batting &&
    !!away.bullpen;

  return {
    gamePk: game.gamePk,
    gameDate: game.gameDate,
    venue: game.venue,
    parkFactor,
    weather,
    home,
    away,
    flags,
    complete,
  };
}

/** Assemble core data for every game on a date. */
export async function assembleDate(
  date: string,
  source: CoreDataSource,
  opts: AssembleOptions,
): Promise<GameCoreData[]> {
  const games = await source.getSchedule(date);
  return Promise.all(games.map((g) => assembleGameCoreData(g, source, opts)));
}

/** Re-tag a feature builder's flags with a side/component prefix for the game view. */
function promoteFlags(
  featureFlags: DataQualityFlag[],
  prefix: string,
  out: DataQualityFlag[],
): void {
  for (const f of featureFlags) {
    out.push({ ...f, code: `${prefix}_${f.code}` });
  }
}
