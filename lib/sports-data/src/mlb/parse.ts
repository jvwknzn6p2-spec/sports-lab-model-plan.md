/**
 * Map raw MLB Stats API payloads into the clean sabermetric input shapes.
 * Parsers are defensive about types (the API mixes numbers and numeric strings)
 * and fail loudly when a *required* stat is absent, so bad data downgrades a
 * prediction instead of silently becoming zero.
 */

import type {
  GameLineups,
  LineupSlot,
} from "../features/lineup";
import type { RawBattingLine } from "../sabermetrics/batting";
import type { RawPitchingLine } from "../sabermetrics/pitching";
import type {
  MlbScheduleGame,
  MlbScheduleGameSide,
  MlbScheduleResponse,
  MlbStatsResponse,
  MlbPersonRef,
} from "./types";

export class MlbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MlbParseError";
  }
}

/** Coerce an API value that may be a number or numeric string. */
function n(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Required numeric field: throws if missing (fail loud). */
function req(stat: Record<string, unknown>, key: string, ctx: string): number {
  const v = n(stat[key]);
  if (v === undefined) {
    throw new MlbParseError(`Missing required stat "${key}" in ${ctx}`);
  }
  return v;
}

/** Pull the first stat split object out of a stats envelope, or null. */
export function firstSplitStat(
  res: MlbStatsResponse,
): Record<string, unknown> | null {
  const stat = res.stats?.[0]?.splits?.[0]?.stat;
  return stat && typeof stat === "object" ? stat : null;
}

export interface NormalizedGame {
  gamePk: number;
  gameDate: string | null;
  status: string | null;
  /** "Preview" | "Live" | "Final" (null when the API omits it). */
  abstractState: string | null;
  /** "R" regular season, "A" All-Star, "P" postseason… (null when omitted). */
  gameType: string | null;
  venue: { id: number | null; name: string | null };
  home: NormalizedGameSide;
  away: NormalizedGameSide;
}

export interface NormalizedGameSide {
  teamId: number | null;
  teamName: string | null;
  probablePitcherId: number | null;
  probablePitcherName: string | null;
  /** Final/live runs scored; null before first pitch. */
  score: number | null;
}

export function normalizeSchedule(res: MlbScheduleResponse): NormalizedGame[] {
  const games: NormalizedGame[] = [];
  for (const date of res.dates ?? []) {
    for (const g of date.games ?? []) {
      games.push(normalizeGame(g));
    }
  }
  return games;
}

function normalizeGame(g: MlbScheduleGame): NormalizedGame {
  const side = (s: MlbScheduleGameSide | undefined): NormalizedGameSide => ({
    teamId: s?.team?.id ?? null,
    teamName: s?.team?.name ?? null,
    probablePitcherId: s?.probablePitcher?.id ?? null,
    probablePitcherName: s?.probablePitcher?.fullName ?? null,
    score: typeof s?.score === "number" ? s.score : null,
  });
  return {
    gamePk: g.gamePk,
    gameDate: g.gameDate ?? null,
    status: g.status?.detailedState ?? null,
    abstractState: g.status?.abstractGameState ?? null,
    gameType: g.gameType ?? null,
    venue: { id: g.venue?.id ?? null, name: g.venue?.name ?? null },
    home: side(g.teams?.home),
    away: side(g.teams?.away),
  };
}

/** Map an MLB pitching stat object into a RawPitchingLine. */
export function parsePitchingLine(
  stat: Record<string, unknown>,
  ctx = "pitching",
): RawPitchingLine {
  const ipRaw = stat["inningsPitched"];
  if (ipRaw === undefined || ipRaw === null) {
    throw new MlbParseError(`Missing inningsPitched in ${ctx}`);
  }
  return {
    inningsPitched: typeof ipRaw === "number" ? ipRaw : String(ipRaw),
    battersFaced: n(stat["battersFaced"]),
    strikeOuts: req(stat, "strikeOuts", ctx),
    baseOnBalls: req(stat, "baseOnBalls", ctx),
    hitByPitch: n(stat["hitByPitch"]),
    homeRuns: req(stat, "homeRuns", ctx),
    hits: n(stat["hits"]),
    earnedRuns: n(stat["earnedRuns"]),
    runs: n(stat["runs"]),
    atBats: n(stat["atBats"]),
    sacFlies: n(stat["sacFlies"]),
    // Batted-ball detail (flyBalls/groundBalls) is not exposed in season stat
    // splits, so it is intentionally omitted; xFIP falls back to a league
    // fly-ball estimate and flags itself as estimated.
  };
}

/** Map an MLB hitting stat object into a RawBattingLine. */
export function parseBattingLine(
  stat: Record<string, unknown>,
  ctx = "batting",
): RawBattingLine {
  return {
    plateAppearances: n(stat["plateAppearances"]),
    atBats: req(stat, "atBats", ctx),
    hits: req(stat, "hits", ctx),
    doubles: req(stat, "doubles", ctx),
    triples: req(stat, "triples", ctx),
    homeRuns: req(stat, "homeRuns", ctx),
    baseOnBalls: req(stat, "baseOnBalls", ctx),
    intentionalWalks: n(stat["intentionalWalks"]),
    hitByPitch: n(stat["hitByPitch"]),
    sacFlies: n(stat["sacFlies"]),
    strikeOuts: n(stat["strikeOuts"]),
    stolenBases: n(stat["stolenBases"]),
    caughtStealing: n(stat["caughtStealing"]),
  };
}

/**
 * Posted batting orders from a lineups-hydrated schedule, keyed by
 * stringified gamePk. Only full nines are kept: a partially published order
 * cannot be weighted honestly (see features/lineup.ts), so it is treated as
 * not posted. Extra entries beyond nine (a DH slot duplicated by some feeds)
 * are trimmed to the first nine, which is the batting order.
 */
export function parseScheduleLineups(
  res: MlbScheduleResponse,
): Record<string, GameLineups> {
  const out: Record<string, GameLineups> = {};
  for (const date of res.dates ?? []) {
    for (const g of date.games ?? []) {
      const side = (players?: MlbPersonRef[]): LineupSlot[] | null => {
        const nine = (players ?? [])
          .filter((p): p is MlbPersonRef & { id: number } => typeof p.id === "number")
          .slice(0, 9)
          .map((p) => ({ playerId: p.id, name: p.fullName ?? null }));
        return nine.length === 9 ? nine : null;
      };
      const home = side(g.lineups?.homePlayers);
      const away = side(g.lineups?.awayPlayers);
      if (home && away) out[String(g.gamePk)] = { home, away };
      else if (home || away) {
        // One side posted, one not: keep what exists — the assembler applies
        // lineups per side, so a half-posted game still upgrades one team.
        out[String(g.gamePk)] = {
          home: home ?? [],
          away: away ?? [],
        };
      }
    }
  }
  return out;
}
