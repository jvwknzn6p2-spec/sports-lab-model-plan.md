/**
 * NPB context inputs derived from the season's own game log — the月間
 * schedule pages, which carry every finished game's venue and final score.
 * Two features come out of the same parsed list:
 *
 *   RECENT FORM — each club's last ≤15 finished games (the model-plan's
 *   Step-3 form window), runs scored/allowed per game. Same shape the MLB
 *   form builder produces, so the feature pipeline is untouched.
 *
 *   PARK FACTORS — derived from the season's games at each park, never
 *   copied from a table typed in from memory:
 *
 *       PF_raw   = (runs/game at the venue) / (league runs/game)
 *       PF       = 100 + (PF_raw·100 − 100) · n / (n + K),   K = 60
 *
 *   The regression constant K = 60 half-weights a venue at ~60 games —
 *   roughly a full NPB home slate — mirroring the standard practice of
 *   halving single-year park factors before use (single-season PFs are
 *   notoriously noisy). Only the 12 main home parks receive an id and a
 *   factor; a 地方開催 game's venue keeps id null and runs park-neutral,
 *   which its tiny sample would have regressed to anyway.
 *
 * Venue names are matched CANONICALLY (all spaces stripped): the schedule
 * pads names like 横　浜 with full-width spaces that the cell-text
 * collapser turns into single spaces — raw equality would silently drop
 * two parks' worth of data.
 */

import type { TeamRecentForm } from "../step2";
import type { NpbScheduleGame } from "./parse";
import { NPB_TEAMS } from "./teams";

/** Canonical venue key: every space (half- or full-width) stripped. */
export const canonicalVenue = (s: string): string =>
  s.replace(/[\s　]+/g, "");

const VENUE_ID_BY_CANONICAL = new Map(
  NPB_TEAMS.map((t) => [canonicalVenue(t.homeVenue), t.venueId]),
);

/** The venueId for a schedule venue string; null off the 12 main parks. */
export function venueIdFor(venue: string): number | null {
  return VENUE_ID_BY_CANONICAL.get(canonicalVenue(venue)) ?? null;
}

/** Finished, uncancelled games strictly BEFORE `beforeDate`. */
const finishedBefore = (
  games: NpbScheduleGame[],
  beforeDate: string,
): NpbScheduleGame[] =>
  games.filter(
    (g) =>
      !g.cancelled &&
      g.homeScore !== null &&
      g.awayScore !== null &&
      g.date < beforeDate,
  );

/**
 * Last ≤15 finished games per club, from the season game log. The slate
 * date's own games are excluded even when scores are already posted (form
 * must describe what was known BEFORE the game).
 */
export function buildNpbForms(
  games: NpbScheduleGame[],
  slateDate: string,
  target = 15,
): Record<string, TeamRecentForm> {
  const byTeam = new Map<number, { scored: number; allowed: number }[]>();
  for (const g of finishedBefore(games, slateDate).sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    const push = (teamId: number, scored: number, allowed: number) => {
      const list = byTeam.get(teamId) ?? [];
      list.push({ scored, allowed });
      byTeam.set(teamId, list);
    };
    push(g.home.teamId, g.homeScore!, g.awayScore!);
    push(g.away.teamId, g.awayScore!, g.homeScore!);
  }
  const forms: Record<string, TeamRecentForm> = {};
  for (const [teamId, list] of byTeam) {
    const recent = list.slice(-target);
    const n = recent.length;
    if (n === 0) continue;
    const sum = (f: (x: { scored: number; allowed: number }) => number) =>
      recent.reduce((a, x) => a + f(x), 0);
    forms[String(teamId)] = {
      games: n,
      runsScoredPerGame: round2(sum((x) => x.scored) / n),
      runsAllowedPerGame: round2(sum((x) => x.allowed) / n),
    };
  }
  return forms;
}

/** Regression constant: half-weight a park at 60 games (≈ one home slate). */
export const PARK_REGRESSION_GAMES = 60;

/**
 * Derived park factors for the 12 main parks, keyed by stringified venueId
 * (the FixtureBundle's own convention). Games at unidentified venues count
 * toward the league baseline but produce no factor of their own.
 */
export function buildNpbParkFactors(
  games: NpbScheduleGame[],
  slateDate: string,
  regressionGames = PARK_REGRESSION_GAMES,
): { parkFactors: Record<string, number>; leagueRunsPerGame: number } {
  const done = finishedBefore(games, slateDate);
  if (done.length === 0) return { parkFactors: {}, leagueRunsPerGame: 0 };

  let leagueRuns = 0;
  const byVenue = new Map<number, { runs: number; n: number }>();
  for (const g of done) {
    const total = g.homeScore! + g.awayScore!;
    leagueRuns += total;
    const id = venueIdFor(g.venue);
    if (id === null) continue;
    const v = byVenue.get(id) ?? { runs: 0, n: 0 };
    v.runs += total;
    v.n += 1;
    byVenue.set(id, v);
  }
  const leagueRunsPerGame = leagueRuns / done.length;

  const parkFactors: Record<string, number> = {};
  for (const [id, v] of byVenue) {
    const raw = (v.runs / v.n / leagueRunsPerGame) * 100;
    const regressed = 100 + (raw - 100) * (v.n / (v.n + regressionGames));
    parkFactors[String(id)] = Math.round(regressed);
  }
  return { parkFactors, leagueRunsPerGame: round2(leagueRunsPerGame) };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
