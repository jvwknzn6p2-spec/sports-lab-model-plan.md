/**
 * Recent-form builder — each team's last-N-games scoring (plan Step 3).
 *
 * Walks the schedule backwards one day at a time and, for every FINAL game,
 * records both teams' runs scored/allowed. A team's form window is its most
 * recent `gamesTarget` (default 15) finals. Scanning stops early once every
 * team of interest has a full window, and is bounded by `maxDays` so an
 * offseason date can't loop forever.
 *
 * Uses only the schedule+linescore endpoint (no boxscores) — one request per
 * calendar day. Entirely fail-soft: an unreachable day is warned and skipped;
 * a team with no collected games simply has no form entry, and the run model
 * applies no adjustment for it.
 */

import type { MlbStatsClient } from "../mlb/client";
import { normalizeSchedule } from "../mlb/parse";
import type { TeamRecentForm } from "../step2";
import { previousDates } from "./workload-builder";

export interface FormBuildReport {
  /** teamId → recent form (absent when no finals were found in the window). */
  forms: Record<string, TeamRecentForm>;
  daysScanned: number;
  gamesScanned: number;
  warnings: string[];
}

export const FORM_GAMES_TARGET = 15;
/** Calendar-days cap on the backward scan (covers 15 games + off days). */
export const FORM_MAX_DAYS = 25;

interface Tally {
  games: number;
  scored: number;
  allowed: number;
}

export async function buildForms(opts: {
  date: string;
  client: MlbStatsClient;
  /** Teams to collect for (slate teams). Others found are collected too. */
  teamIds: number[];
  gamesTarget?: number;
  maxDays?: number;
}): Promise<FormBuildReport> {
  const { date, client } = opts;
  const gamesTarget = opts.gamesTarget ?? FORM_GAMES_TARGET;
  const maxDays = opts.maxDays ?? FORM_MAX_DAYS;
  const wanted = new Set(opts.teamIds);
  const warnings: string[] = [];
  const tallies = new Map<number, Tally>();
  let gamesScanned = 0;
  let daysScanned = 0;

  const done = () =>
    wanted.size > 0 &&
    [...wanted].every((id) => (tallies.get(id)?.games ?? 0) >= gamesTarget);

  for (const day of previousDates(date, maxDays)) {
    if (done()) break;
    daysScanned++;
    let games;
    try {
      games = normalizeSchedule(await client.scheduleResults(day));
    } catch (err) {
      warnings.push(
        `${day}: schedule unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    for (const g of games) {
      if (g.abstractState !== "Final") continue;
      if (g.home.score === null || g.away.score === null) continue;
      gamesScanned++;
      const sides = [
        { teamId: g.home.teamId, scored: g.home.score, allowed: g.away.score },
        { teamId: g.away.teamId, scored: g.away.score, allowed: g.home.score },
      ];
      for (const s of sides) {
        if (s.teamId === null) continue;
        const t = tallies.get(s.teamId) ?? { games: 0, scored: 0, allowed: 0 };
        // Days are visited most-recent-first, so stop at the window size.
        if (t.games >= gamesTarget) continue;
        t.games++;
        t.scored += s.scored;
        t.allowed += s.allowed;
        tallies.set(s.teamId, t);
      }
    }
  }

  const forms: Record<string, TeamRecentForm> = {};
  for (const [teamId, t] of tallies) {
    if (t.games === 0) continue;
    forms[String(teamId)] = {
      games: t.games,
      runsScoredPerGame: Math.round((t.scored / t.games) * 100) / 100,
      runsAllowedPerGame: Math.round((t.allowed / t.games) * 100) / 100,
    };
  }

  for (const id of wanted) {
    const got = tallies.get(id)?.games ?? 0;
    if (got < gamesTarget) {
      warnings.push(
        `team ${id}: only ${got}/${gamesTarget} recent finals within ${maxDays} days`,
      );
    }
  }

  return { forms, daysScanned, gamesScanned, warnings };
}
