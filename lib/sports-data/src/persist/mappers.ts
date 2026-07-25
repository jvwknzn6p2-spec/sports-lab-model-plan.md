/**
 * Pure mappers from Step-2 features/metrics into `@workspace/db` insert rows.
 *
 * These are the bridge between the compute layer and storage (plan Section 3:
 * "cache daily pulls", "store it"). They are pure functions returning typed
 * rows — the actual `db.insert(...)` call lives in the caller, so this module
 * never opens a database connection and stays trivially testable.
 *
 * Only TYPES are imported from the db package, so importing this module never
 * triggers the DATABASE_URL runtime check.
 */

import type {
  InsertBullpenStats,
  InsertGame,
  InsertPitcherSeasonStats,
  InsertTeamBattingStats,
} from "@workspace/db/schema";

import type { BullpenFeatures } from "../features/bullpen";
import type { StartingPitcherFeatures } from "../features/starting-pitcher";
import type { TeamBattingFeatures } from "../features/team-batting";
import type { NormalizedGame } from "../mlb/parse";
import type { RawBattingLine, RawPitchingLine } from "../sabermetrics";

const undef = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export function toGameRow(
  game: NormalizedGame,
  season: number,
  parkFactor: number,
): InsertGame {
  return {
    gamePk: game.gamePk,
    season,
    gameDate: game.gameDate ? new Date(game.gameDate) : undefined,
    status: undef(game.status),
    homeTeamMlbId: game.home.teamId ?? 0,
    awayTeamMlbId: game.away.teamId ?? 0,
    homeProbablePitcherMlbId: undef(game.home.probablePitcherId),
    awayProbablePitcherMlbId: undef(game.away.probablePitcherId),
    venueId: undef(game.venue.id),
    venueName: undef(game.venue.name),
    parkFactor,
  };
}

export function toPitcherSeasonStatsRow(
  season: number,
  teamMlbId: number | null,
  line: RawPitchingLine,
  f: StartingPitcherFeatures,
): InsertPitcherSeasonStats {
  const m = f.metrics;
  return {
    mlbPersonId: f.pitcherId ?? 0,
    season,
    teamMlbId: undef(teamMlbId),
    outs: m.outs,
    battersFaced: undef(m.battersFaced),
    strikeOuts: line.strikeOuts,
    baseOnBalls: line.baseOnBalls,
    hitByPitch: line.hitByPitch ?? undefined,
    homeRuns: line.homeRuns,
    hits: line.hits ?? undefined,
    earnedRuns: line.earnedRuns ?? undefined,
    runs: line.runs ?? undefined,
    fip: undef(m.fip),
    xfip: undef(m.xfip),
    fipMinus: undef(m.fipMinus),
    kwera: undef(m.kwera),
    era: undef(m.era),
    whip: undef(m.whip),
    k9: undef(m.k9),
    bb9: undef(m.bb9),
    hr9: undef(m.hr9),
    kPct: undef(m.kPct),
    bbPct: undef(m.bbPct),
    kMinusBbPct: undef(m.kMinusBbPct),
    babip: undef(m.babip),
    lobPct: undef(m.lobPct),
    constantsSeason: m.season,
  };
}

export function toTeamBattingStatsRow(
  season: number,
  line: RawBattingLine,
  f: TeamBattingFeatures,
  gamesPlayed?: number,
): InsertTeamBattingStats {
  const m = f.metrics;
  return {
    teamMlbId: f.teamId ?? 0,
    season,
    gamesPlayed,
    plateAppearances: m.plateAppearances,
    atBats: line.atBats,
    hits: line.hits,
    doubles: line.doubles,
    triples: line.triples,
    homeRuns: line.homeRuns,
    baseOnBalls: line.baseOnBalls,
    intentionalWalks: line.intentionalWalks ?? undefined,
    hitByPitch: line.hitByPitch ?? undefined,
    sacFlies: line.sacFlies ?? undefined,
    strikeOuts: line.strikeOuts ?? undefined,
    stolenBases: line.stolenBases ?? undefined,
    caughtStealing: line.caughtStealing ?? undefined,
    avg: undef(m.avg),
    obp: undef(m.obp),
    slg: undef(m.slg),
    ops: undef(m.ops),
    iso: undef(m.iso),
    woba: undef(m.woba),
    wraa: undef(m.wraa),
    wrc: undef(m.wrc),
    wrcPlus: undef(m.wrcPlus),
    kPct: undef(m.kPct),
    bbPct: undef(m.bbPct),
    babip: undef(m.babip),
    constantsSeason: m.season,
  };
}

export function toBullpenStatsRow(
  season: number,
  line: RawPitchingLine,
  f: BullpenFeatures,
  workload?: { last3DaysIP?: number; unavailableKeyArms?: number },
): InsertBullpenStats {
  const m = f.metrics;
  return {
    teamMlbId: f.teamId ?? 0,
    season,
    outs: m.outs,
    battersFaced: undef(m.battersFaced),
    strikeOuts: line.strikeOuts,
    baseOnBalls: line.baseOnBalls,
    hitByPitch: line.hitByPitch ?? undefined,
    homeRuns: line.homeRuns,
    hits: line.hits ?? undefined,
    earnedRuns: line.earnedRuns ?? undefined,
    runs: line.runs ?? undefined,
    fip: undef(m.fip),
    xfip: undef(m.xfip),
    fipMinus: undef(m.fipMinus),
    era: undef(m.era),
    whip: undef(m.whip),
    k9: undef(m.k9),
    bb9: undef(m.bb9),
    last3DaysIp: workload?.last3DaysIP,
    unavailableKeyArms: workload?.unavailableKeyArms,
    constantsSeason: m.season,
  };
}
