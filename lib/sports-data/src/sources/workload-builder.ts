/**
 * Bullpen-workload builder — automates the fatigue inputs.
 *
 * For each of the last N days (default 3) it pulls that date's schedule, and
 * for every FINAL game fetches the boxscore and sums each team's RELIEF
 * innings: every pitcher who appeared with gamesStarted = 0. The per-team
 * totals become the `workloads` map the bullpen feature builder consumes
 * (`last3DaysIP` drives the fatigue penalty in runs/9).
 *
 * Entirely fail-soft by design: a missing boxscore or an unreachable past
 * date degrades to "no workload data for that team", which the engine treats
 * as a fresh bullpen (no penalty) — it never blocks slate generation.
 * `unavailableKeyArms` stays a manual field (injury/availability news is not
 * in the boxscore); edit it in the generated slate when you know an arm is
 * down.
 */

import type { BullpenWorkload } from "../features";
import type { MlbStatsClient } from "../mlb/client";
import { normalizeSchedule } from "../mlb/parse";
import type { MlbBoxscoreTeam } from "../mlb/types";
import { inningsToOuts } from "../sabermetrics";

export interface WorkloadBuildReport {
  /** teamId → workload (teams with zero recent relief IP are included as 0). */
  workloads: Record<string, BullpenWorkload>;
  daysScanned: string[];
  gamesScanned: number;
  warnings: string[];
}

/** Previous N dates (YYYY-MM-DD), most recent first, excluding `date` itself. */
export function previousDates(date: string, days: number): string[] {
  const base = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`Invalid date "${date}" (want YYYY-MM-DD)`);
  }
  const out: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(base.getTime() - i * 24 * 60 * 60 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Sum relief outs (gamesStarted = 0 appearances) for one boxscore side. */
function reliefOuts(
  team: MlbBoxscoreTeam | undefined,
  warnings: string[],
  ctx: string,
): number {
  let outs = 0;
  for (const player of Object.values(team?.players ?? {})) {
    const p = player.stats?.pitching;
    if (!p || p.inningsPitched === undefined) continue; // non-pitcher
    if ((p.gamesStarted ?? 0) > 0) continue; // the starter
    try {
      outs += inningsToOuts(p.inningsPitched);
    } catch {
      warnings.push(`${ctx}: unparseable IP "${p.inningsPitched}"`);
    }
  }
  return outs;
}

export async function buildWorkloads(opts: {
  date: string;
  client: MlbStatsClient;
  days?: number;
}): Promise<WorkloadBuildReport> {
  const { date, client } = opts;
  const days = opts.days ?? 3;
  const daysScanned = previousDates(date, days);
  const warnings: string[] = [];
  const outsByTeam = new Map<number, number>();
  let gamesScanned = 0;

  for (const day of daysScanned) {
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
      if (g.abstractState !== "Final") continue; // no usage to count yet
      let box;
      try {
        box = await client.boxscore(g.gamePk);
      } catch (err) {
        warnings.push(
          `game ${g.gamePk} (${day}): boxscore unavailable (${err instanceof Error ? err.message : String(err)})`,
        );
        continue;
      }
      gamesScanned++;
      const sides = [
        { teamId: g.home.teamId, box: box.teams?.home },
        { teamId: g.away.teamId, box: box.teams?.away },
      ];
      for (const s of sides) {
        if (s.teamId === null) continue;
        const outs = reliefOuts(
          s.box,
          warnings,
          `game ${g.gamePk} team ${s.teamId}`,
        );
        outsByTeam.set(s.teamId, (outsByTeam.get(s.teamId) ?? 0) + outs);
      }
    }
  }

  const workloads: Record<string, BullpenWorkload> = {};
  for (const [teamId, outs] of outsByTeam) {
    workloads[String(teamId)] = {
      last3DaysIP: Math.round((outs / 3) * 10) / 10,
    };
  }

  return { workloads, daysScanned, gamesScanned, warnings };
}
