/**
 * IL (injured list) detection from the MLB 40-man roster.
 *
 * What this deliberately is NOT: a numeric adjustment. Who replaces an
 * injured player, and how much worse the replacement is, is not in any feed
 * we pull — an invented penalty would be a fabricated input. What the roster
 * CAN say honestly is which players are unavailable, so the pipeline:
 *
 *   - records each slate team's IL list on the slate (audit trail),
 *   - raises an [info] flag per side listing the names, so a stacked IL is
 *     visible on the pick and in A-4 input-health,
 *   - hands the list to the AI review layer (Step 9), whose Matchup Analyst
 *     can weigh "their closer and two starters are down" qualitatively.
 *
 * Status codes: IL players carry D-codes (D7/D10/D15/D60). Everything else
 * (A = active, minors options, etc.) is not an absence worth flagging.
 */

import type { MlbStatsClient } from "../mlb/client";

export interface IlPlayer {
  name: string;
  position: string | null;
  /** The roster status description, e.g. "60-Day Injured List". */
  status: string;
}

export interface InjuriesBuildReport {
  /** Keyed by stringified teamId. Present (possibly empty) per fetched team. */
  injuries: Record<string, IlPlayer[]>;
  warnings: string[];
}

const IL_CODE = /^D\d+$/;

export async function buildInjuries(opts: {
  client: MlbStatsClient;
  teamIds: number[];
  season: number;
}): Promise<InjuriesBuildReport> {
  const warnings: string[] = [];
  const injuries: Record<string, IlPlayer[]> = {};
  for (const teamId of new Set(opts.teamIds)) {
    try {
      const roster = await opts.client.teamRoster(teamId, opts.season);
      injuries[String(teamId)] = (roster.roster ?? [])
        .filter((r) => IL_CODE.test(r.status?.code ?? ""))
        .map((r) => ({
          name: r.person?.fullName ?? `player ${r.person?.id ?? "?"}`,
          position: r.position?.abbreviation ?? null,
          status: r.status?.description ?? r.status?.code ?? "IL",
        }));
    } catch (err) {
      warnings.push(
        `team ${teamId}: roster fetch failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return { injuries, warnings };
}
