/**
 * Team-batting feature builder — wOBA-forward.
 *
 * Lineup strength is expressed as expected runs scored per game, derived from
 * wOBA (each event weighted by its run value), NOT from raw runs or AVG. Steps:
 *
 *   1. Compute wOBA / wRC+ and the offensive rate stats.
 *   2. Convert wOBA into a runs-per-PA rate against the league baseline.
 *   3. Scale by the team's plate appearances per game to get runs per game.
 *
 * The result is a park-neutral offensive baseline; venue and opponent-pitching
 * adjustments are applied later in the run model, not here, to avoid
 * double-counting.
 */

import {
  computeBattingMetrics,
  getLeagueConstants,
  type BattingMetrics,
  type RawBattingLine,
} from "../sabermetrics";
import { reliabilityWeight, type DataQualityFlag } from "./types";

/** PA-of-prior used to regress a lineup's wOBA toward league average. */
export const TEAM_WOBA_PRIOR_PA = 600;
/** Default team plate appearances per game when games played is unknown. */
const DEFAULT_PA_PER_GAME = 38;
const LOW_SAMPLE_PA = 300;

export interface TeamBattingInput {
  teamId?: number;
  teamName?: string;
  season: number;
  line: RawBattingLine;
  /** Games played, used to derive PA/game; falls back to a league default. */
  gamesPlayed?: number;
}

export interface TeamBattingFeatures {
  teamId: number | null;
  teamName: string | null;
  metrics: BattingMetrics;
  /** wOBA regressed toward league mean by PA sample. */
  projectedWoba: number;
  /** Expected runs scored per game (park-neutral). */
  expectedRunsPerGame: number;
  paPerGame: number;
  reliability: number;
  flags: DataQualityFlag[];
}

export function buildTeamBattingFeatures(
  input: TeamBattingInput,
): TeamBattingFeatures {
  const { line, season } = input;
  const c = getLeagueConstants(season);
  const metrics = computeBattingMetrics(line, season);
  const pa = metrics.plateAppearances;
  const flags: DataQualityFlag[] = [];

  // 1–2. Regress wOBA toward league mean, then convert to runs per PA.
  const observedWoba = metrics.woba ?? c.wOBA;
  if (metrics.woba === null) {
    flags.push({
      code: "batting_no_woba",
      severity: "downgrade",
      message: "Could not compute wOBA; using league-average offense.",
    });
  }
  const projectedWoba =
    (pa * observedWoba + TEAM_WOBA_PRIOR_PA * c.wOBA) /
    (pa + TEAM_WOBA_PRIOR_PA);
  const runsPerPA = (projectedWoba - c.wOBA) / c.wOBAScale + c.runsPerPA;

  // 3. Scale to runs per game.
  const paPerGame =
    input.gamesPlayed && input.gamesPlayed > 0
      ? pa / input.gamesPlayed
      : DEFAULT_PA_PER_GAME;
  const expectedRunsPerGame = Math.max(0, runsPerPA * paPerGame);

  const reliability = reliabilityWeight(pa, TEAM_WOBA_PRIOR_PA);
  if (pa < LOW_SAMPLE_PA) {
    flags.push({
      code: "batting_low_sample",
      severity: "warn",
      message: `Only ${pa} PA; offense heavily regressed to league mean.`,
    });
  }

  return {
    teamId: input.teamId ?? null,
    teamName: input.teamName ?? null,
    metrics,
    projectedWoba: round3(projectedWoba),
    expectedRunsPerGame: round2(expectedRunsPerGame),
    paPerGame: round1(paPerGame),
    reliability: round2(reliability),
    flags,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
