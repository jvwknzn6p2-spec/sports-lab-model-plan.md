/**
 * Baseline run model: Step-2 features → expected runs per team.
 *
 * Explainable, step-by-step (plan Section 4.1):
 *   1. Offense: the team's wOBA-derived expected runs/game.
 *   2. Defense: opponent's run prevention, blending starter and bullpen
 *      FIP-based runs-allowed/9 by expected starter workload (~5.7 IP).
 *   3. Combine offense vs. defense against the league run environment
 *      (odds-ratio / "log5 for runs": exp = off × def / league).
 *   4. Home-field advantage (~4% runs boost home, ~4% cut away, which yields
 *      the historical ~54% home win rate in an otherwise even game).
 */

import { RUNS_PER_EARNED_RUN } from "../features";
import { getLeagueConstants } from "../sabermetrics";
import type { GameCoreData, TeamCoreData } from "../step2";

/** Innings expected from a modern starter (league average is ~5.2–5.8). */
export const DEFAULT_STARTER_IP = 5.7;
const HOME_RUN_BOOST = 1.04;
const AWAY_RUN_CUT = 0.96;
/** Safety clamp for a single team's expected runs. */
const MU_MIN = 2.0;
const MU_MAX = 8.5;

export interface RunExpectation {
  homeMu: number;
  awayMu: number;
  leagueRunsPerGame: number;
  /** Human-readable drivers, used by the decision engine's "reasons". */
  notes: string[];
}

/** Opponent pitching: blended runs-allowed/9 from starter + bullpen. */
function defenseRunsPer9(
  t: TeamCoreData,
  leagueRPG: number,
  notes: string[],
  label: string,
): number {
  const sp = t.starter?.expectedRunsAllowedPer9 ?? leagueRPG;
  const bp = t.bullpen?.expectedRunsAllowedPer9 ?? leagueRPG;
  if (!t.starter)
    notes.push(`${label}: no starter data — league-average assumed`);
  if (!t.bullpen)
    notes.push(`${label}: no bullpen data — league-average assumed`);
  const w = DEFAULT_STARTER_IP / 9;
  return sp * w + bp * (1 - w);
}

export function expectedRuns(g: GameCoreData, season: number): RunExpectation {
  const c = getLeagueConstants(season);
  const leagueRPG = c.lgFIP * RUNS_PER_EARNED_RUN;
  const notes: string[] = [];

  const homeOff = g.home.batting?.expectedRunsPerGame ?? leagueRPG;
  const awayOff = g.away.batting?.expectedRunsPerGame ?? leagueRPG;
  if (!g.home.batting)
    notes.push("home: no batting data — league-average assumed");
  if (!g.away.batting)
    notes.push("away: no batting data — league-average assumed");

  // Each offense faces the OPPONENT's pitching.
  const homeDef = defenseRunsPer9(g.home, leagueRPG, notes, "home");
  const awayDef = defenseRunsPer9(g.away, leagueRPG, notes, "away");

  const clamp = (v: number) => Math.min(MU_MAX, Math.max(MU_MIN, v));
  const homeMu = clamp(((homeOff * awayDef) / leagueRPG) * HOME_RUN_BOOST);
  const awayMu = clamp(((awayOff * homeDef) / leagueRPG) * AWAY_RUN_CUT);

  return {
    homeMu: round2(homeMu),
    awayMu: round2(awayMu),
    leagueRunsPerGame: round2(leagueRPG),
    notes,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
