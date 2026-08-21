/**
 * Baseline run model: Step-2 features → expected runs per team.
 *
 * Explainable, step-by-step (plan Section 4.1):
 *   1. Offense: the team's wOBA-derived expected runs/game.
 *   2. Defense: opponent's run prevention, blending starter and bullpen
 *      FIP-based runs-allowed/9 by expected starter workload (~5.7 IP).
 *   3. Recent form: blend the last ~15 games' scoring into the season
 *      baselines, weighted by sample size and deliberately regressed hard
 *      (small samples are noisy — plan Section 7). Offense gets up to ~30%
 *      form weight at a full 15-game window; run prevention only ~20%,
 *      because today's specific starter already dominates that side.
 *   4. Combine offense vs. defense against the league run environment
 *      (odds-ratio / "log5 for runs": exp = off × def / league).
 *   5. Home-field advantage (~4% runs boost home, ~4% cut away, which yields
 *      the historical ~54% home win rate in an otherwise even game).
 */

import { RUNS_PER_EARNED_RUN } from "../features";
import { getLeagueConstants } from "../sabermetrics";
import {
  temperatureRunMultiplier,
  windRunMultiplier,
} from "../sources/weather";
import type { GameCoreData, TeamCoreData, TeamRecentForm } from "../step2";

/** Innings expected from a modern starter (league average is ~5.2–5.8). */
export const DEFAULT_STARTER_IP = 5.7;
const HOME_RUN_BOOST = 1.04;
const AWAY_RUN_CUT = 0.96;
/** Safety clamp for a single team's expected runs. */
const MU_MIN = 2.0;
const MU_MAX = 8.5;
/** Pseudo-game priors for form blending: weight = games/(games+prior). */
export const FORM_OFFENSE_PRIOR_GAMES = 35; // 15 games → ~30% weight
export const FORM_DEFENSE_PRIOR_GAMES = 60; // 15 games → ~20% weight

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

/** Blend a season baseline toward recent form by sample-weighted regression. */
function blendForm(
  seasonValue: number,
  formValue: number | undefined,
  formGames: number,
  priorGames: number,
): number {
  if (formValue === undefined || formGames <= 0) return seasonValue;
  const w = formGames / (formGames + priorGames);
  return (1 - w) * seasonValue + w * formValue;
}

function formNote(
  label: string,
  form: TeamRecentForm | null,
  seasonOff: number,
  notes: string[],
): void {
  if (!form) return;
  const diff = form.runsScoredPerGame - seasonOff;
  if (Math.abs(diff) >= 0.5) {
    notes.push(
      `${label}: ${diff > 0 ? "hot" : "cold"} bats — ${form.runsScoredPerGame.toFixed(1)} R/G last ${form.games} (season baseline ${seasonOff.toFixed(1)})`,
    );
  }
}

export function expectedRuns(g: GameCoreData, season: number): RunExpectation {
  const c = getLeagueConstants(season);
  const leagueRPG = c.lgFIP * RUNS_PER_EARNED_RUN;
  const notes: string[] = [];

  const homeSeasonOff = g.home.batting?.expectedRunsPerGame ?? leagueRPG;
  const awaySeasonOff = g.away.batting?.expectedRunsPerGame ?? leagueRPG;
  if (!g.home.batting)
    notes.push("home: no batting data — league-average assumed");
  if (!g.away.batting)
    notes.push("away: no batting data — league-average assumed");

  // 3. Recent form: nudge season offense toward last-N scoring (regressed).
  const homeOff = blendForm(
    homeSeasonOff,
    g.home.form?.runsScoredPerGame,
    g.home.form?.games ?? 0,
    FORM_OFFENSE_PRIOR_GAMES,
  );
  const awayOff = blendForm(
    awaySeasonOff,
    g.away.form?.runsScoredPerGame,
    g.away.form?.games ?? 0,
    FORM_OFFENSE_PRIOR_GAMES,
  );
  formNote("home", g.home.form, homeSeasonOff, notes);
  formNote("away", g.away.form, awaySeasonOff, notes);

  // Each offense faces the OPPONENT's pitching, itself nudged by the
  // opponent's recent runs-allowed (regressed harder — starter dominates).
  const homeDef = blendForm(
    defenseRunsPer9(g.home, leagueRPG, notes, "home"),
    g.home.form?.runsAllowedPerGame,
    g.home.form?.games ?? 0,
    FORM_DEFENSE_PRIOR_GAMES,
  );
  const awayDef = blendForm(
    defenseRunsPer9(g.away, leagueRPG, notes, "away"),
    g.away.form?.runsAllowedPerGame,
    g.away.form?.games ?? 0,
    FORM_DEFENSE_PRIOR_GAMES,
  );

  // 6. Weather: a symmetric temperature nudge at open-air parks, plus the
  // wind's out/in-blowing component where the park's orientation is known
  // (see sources/weather.ts for the constants and the honesty rules — domes
  // and unknown-state retractable roofs stay at 1.0, as does any game
  // missing a reading, a direction, or a believable bearing).
  const tempMult = temperatureRunMultiplier(g.weather ?? null);
  if (tempMult !== 1 && g.weather?.temperatureC != null) {
    notes.push(
      `Weather: ${g.weather.temperatureC.toFixed(0)}°C at first pitch — ` +
        `run environment ×${tempMult.toFixed(3)}`,
    );
  }
  const windMult = windRunMultiplier(g.weather ?? null);
  if (windMult !== 1 && g.weather?.windSpeedKmh != null) {
    notes.push(
      `Wind: ${g.weather.windSpeedKmh.toFixed(0)} km/h from ` +
        `${g.weather.windDirectionDeg!.toFixed(0)}° vs CF bearing ` +
        `${g.weather.cfBearingDeg!.toFixed(0)}° — blowing ` +
        `${windMult > 1 ? "out" : "in"}, run environment ×${windMult.toFixed(3)}`,
    );
  }
  const wxMult = tempMult * windMult;

  const clamp = (v: number) => Math.min(MU_MAX, Math.max(MU_MIN, v));
  const homeMu = clamp(
    ((homeOff * awayDef) / leagueRPG) * HOME_RUN_BOOST * wxMult,
  );
  const awayMu = clamp(
    ((awayOff * homeDef) / leagueRPG) * AWAY_RUN_CUT * wxMult,
  );

  return {
    homeMu: round2(homeMu),
    awayMu: round2(awayMu),
    leagueRunsPerGame: round2(leagueRPG),
    notes,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
