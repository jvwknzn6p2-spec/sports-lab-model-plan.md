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
}

export interface TeamCoreData {
  teamId: number | null;
  teamName: string | null;
  starter: StartingPitcherFeatures | null;
  batting: TeamBattingFeatures | null;
  bullpen: BullpenFeatures | null;
}

export interface GameCoreData {
  gamePk: number;
  gameDate: string | null;
  venue: { id: number | null; name: string | null };
  parkFactor: number;
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

    return {
      teamId: side.teamId,
      teamName: side.teamName,
      starter,
      batting,
      bullpen,
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
