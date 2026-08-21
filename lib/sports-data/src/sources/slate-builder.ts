/**
 * Slate builder — turns live MLB Stats API pulls into a FixtureBundle.
 *
 * This is the missing wire between the (already implemented) MlbStatsClient
 * and the daily HandiEdge workflow: one call fetches the schedule, every
 * probable starter's season line, and every team's batting + bullpen lines,
 * and emits the same slate JSON shape `predict` already consumes.
 *
 * Failure policy mirrors the rest of the pipeline:
 *   - The SCHEDULE failing is fatal (nothing to predict) — it throws.
 *   - A single starter/team failing is fail-soft: the entity is omitted from
 *     the bundle and reported as a warning. At predict time the orchestrator
 *     turns the gap into a downgrade flag + PASS, never a fabricated number.
 *
 * Because MlbStatsClient's transport is injectable, this builder runs
 *  identically against the live API or recorded payloads (tests/offline).
 */

import type { MlbStatsClient } from "../mlb/client";
import {
  firstSplitStat,
  normalizeSchedule,
  parseBattingLine,
  parsePitchingLine,
  parseScheduleLineups,
  type NormalizedGame,
} from "../mlb/parse";
import type { GameLineups } from "../features/lineup";
import type { RawBattingLine, RawPitchingLine } from "../sabermetrics";
import type { BullpenWorkload } from "../features";
import type { FixtureBundle } from "./fixture-source";
import { getParkFactor } from "./park-factors";

export interface BuildSlateOptions {
  date: string;
  season: number;
  client: MlbStatsClient;
  /**
   * Optional venueId → park factor OVERRIDES. The builder auto-fills every
   * game's venue from the built-in 30-park table; entries here win over it.
   */
  parkFactors?: Record<string, number>;
  /** Optional teamId → workload map (manual until game-log ingestion lands). */
  workloads?: Record<string, BullpenWorkload>;
}

export interface SlateBuildReport {
  bundle: FixtureBundle;
  games: number;
  startersFetched: number;
  startersExpected: number;
  teamsFetched: number;
  teamsExpected: number;
  /** Games with at least one full nine posted at fetch time. */
  lineupsPosted: number;
  /** Posted-lineup bats whose season line was fetched. */
  lineupBatsFetched: number;
  warnings: string[];
}

async function tryFetch<T>(
  label: string,
  warnings: string[],
  fn: () => Promise<T | null>,
): Promise<T | null> {
  try {
    const value = await fn();
    if (value === null) warnings.push(`${label}: no data returned`);
    return value;
  } catch (err) {
    warnings.push(
      `${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export async function buildSlate(
  opts: BuildSlateOptions,
): Promise<SlateBuildReport> {
  const { date, season, client } = opts;
  const warnings: string[] = [];

  // Schedule is the backbone — let a failure here throw loudly.
  const scheduleRes = await client.schedule(date);
  const games: NormalizedGame[] = normalizeSchedule(scheduleRes);
  // Posted batting orders ride the same schedule response (hydrate=lineups).
  const lineups: Record<string, GameLineups> =
    parseScheduleLineups(scheduleRes);

  const starterIds = new Set<number>();
  const teamIds = new Set<number>();
  for (const g of games) {
    for (const side of [g.home, g.away]) {
      if (side.probablePitcherId !== null)
        starterIds.add(side.probablePitcherId);
      if (side.teamId !== null) teamIds.add(side.teamId);
      else warnings.push(`game ${g.gamePk}: missing team id on one side`);
      if (side.probablePitcherId === null) {
        warnings.push(
          `game ${g.gamePk}: no probable starter for ${side.teamName ?? "?"} yet`,
        );
      }
    }
  }

  const starters: Record<string, RawPitchingLine> = {};
  for (const id of starterIds) {
    const line = await tryFetch(`starter ${id}`, warnings, async () => {
      const stat = firstSplitStat(await client.pitcherSeason(id, season));
      return stat ? parsePitchingLine(stat, `pitcher ${id}`) : null;
    });
    if (line) starters[String(id)] = line;
  }

  const batting: Record<string, RawBattingLine> = {};
  const bullpens: Record<string, RawPitchingLine> = {};
  for (const id of teamIds) {
    const bat = await tryFetch(`team ${id} batting`, warnings, async () => {
      const stat = firstSplitStat(await client.teamBattingSeason(id, season));
      return stat ? parseBattingLine(stat, `team ${id} batting`) : null;
    });
    if (bat) batting[String(id)] = bat;

    const pen = await tryFetch(`team ${id} bullpen`, warnings, async () => {
      const stat = firstSplitStat(
        await client.teamPitchingSeason(id, season, "rp"),
      );
      return stat ? parsePitchingLine(stat, `team ${id} bullpen`) : null;
    });
    if (pen) bullpens[String(id)] = pen;
  }

  // Season hitting lines for every posted-lineup bat, fetched in bulk (the
  // /people endpoint takes ~100 ids per call). Fail-soft: a failed batch
  // leaves its players without lines, and the feature layer fills each such
  // bat with league-average wOBA at zero sample, flagged.
  const lineupBatting: Record<string, RawBattingLine> = {};
  const lineupPlayerIds = [
    ...new Set(
      Object.values(lineups).flatMap((l) =>
        [...l.home, ...l.away].map((p) => p.playerId),
      ),
    ),
  ];
  for (let i = 0; i < lineupPlayerIds.length; i += 100) {
    const chunk = lineupPlayerIds.slice(i, i + 100);
    await tryFetch(`lineup bats ${i / 100 + 1}`, warnings, async () => {
      const res = await client.peopleHitting(chunk, season);
      for (const person of res.people ?? []) {
        if (typeof person.id !== "number") continue;
        const stat = person.stats?.[0]?.splits?.[0]?.stat;
        if (stat && typeof stat === "object") {
          lineupBatting[String(person.id)] = parseBattingLine(
            stat as Record<string, unknown>,
            `player ${person.id} hitting`,
          );
        }
      }
      return res.people?.length ? res : null;
    });
  }

  // Park factors: built-in table per venue, with caller overrides winning.
  // Unknown venues stay absent (predict treats them as neutral 100) — warned,
  // never silently guessed.
  const parkFactors: Record<string, number> = {};
  for (const g of games) {
    const venueId = g.venue.id;
    if (venueId === null) continue;
    const pf = getParkFactor(venueId);
    if (pf !== undefined) parkFactors[String(venueId)] = pf;
    else {
      warnings.push(
        `game ${g.gamePk}: unknown venue ${venueId} (${g.venue.name ?? "?"}) — park treated as neutral (100)`,
      );
    }
  }
  Object.assign(parkFactors, opts.parkFactors ?? {});

  const bundle: FixtureBundle = {
    date,
    season,
    games,
    starters,
    batting,
    bullpens,
    workloads: opts.workloads ?? {},
    parkFactors,
    lineups,
    lineupBatting,
  };

  const teamsFetched = Object.keys(batting).filter(
    (id) => id in bullpens,
  ).length;

  return {
    bundle,
    games: games.length,
    startersFetched: Object.keys(starters).length,
    startersExpected: starterIds.size,
    teamsFetched,
    teamsExpected: teamIds.size,
    lineupsPosted: Object.values(lineups).filter(
      (l) => l.home.length === 9 || l.away.length === 9,
    ).length,
    lineupBatsFetched: Object.keys(lineupBatting).length,
    warnings,
  };
}
