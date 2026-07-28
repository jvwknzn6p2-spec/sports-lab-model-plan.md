/**
 * Offensive metrics, wOBA-centric.
 *
 * Project policy: lineup strength is measured by wOBA / wRC+, not batting
 * average or raw runs. wOBA weights each offensive event by its real run value
 * (a HR is worth far more than a single), and wRC+ indexes offense to the
 * league while adjusting for park — so a 120 wRC+ means "20% better than league
 * average" regardless of era or ballpark.
 */

import { getLeagueConstants, type LeagueConstants } from "./constants";
import { rate, round } from "./units";

/** Raw team/player batting counting stats. */
export interface RawBattingLine {
  readonly plateAppearances?: number;
  readonly atBats: number;
  readonly hits: number;
  readonly doubles: number;
  readonly triples: number;
  readonly homeRuns: number;
  readonly baseOnBalls: number;
  readonly intentionalWalks?: number;
  readonly hitByPitch?: number;
  readonly sacFlies?: number;
  readonly strikeOuts?: number;
  readonly stolenBases?: number;
  readonly caughtStealing?: number;
}

export interface BattingMetrics {
  season: number;
  plateAppearances: number;
  avg: number | null;
  obp: number | null;
  slg: number | null;
  ops: number | null;
  iso: number | null;
  woba: number | null;
  /** Weighted runs above average (runs vs. a league-average hitter). */
  wraa: number | null;
  /** Weighted runs created (absolute run production). */
  wrc: number | null;
  /** wRC+ indexed to league (100 = average, park-neutral here). */
  wrcPlus: number | null;
  kPct: number | null;
  bbPct: number | null;
  babip: number | null;
}

const num = (v: number | undefined): number => v ?? 0;

function singles(line: RawBattingLine): number {
  return line.hits - line.doubles - line.triples - line.homeRuns;
}

/**
 * Plate appearances. Uses the reported value when present, otherwise the
 * standard reconstruction AB + BB + HBP + SF (+ SH, unavailable here).
 */
export function plateAppearances(line: RawBattingLine): number {
  if (line.plateAppearances !== undefined) return line.plateAppearances;
  return (
    line.atBats + line.baseOnBalls + num(line.hitByPitch) + num(line.sacFlies)
  );
}

export function avg(line: RawBattingLine): number | null {
  return rate(line.hits, line.atBats);
}

export function obp(line: RawBattingLine): number | null {
  const denom =
    line.atBats + line.baseOnBalls + num(line.hitByPitch) + num(line.sacFlies);
  return rate(line.hits + line.baseOnBalls + num(line.hitByPitch), denom);
}

export function slg(line: RawBattingLine): number | null {
  const totalBases =
    singles(line) + 2 * line.doubles + 3 * line.triples + 4 * line.homeRuns;
  return rate(totalBases, line.atBats);
}

/**
 * wOBA = (wBB·uBB + wHBP·HBP + w1B·1B + w2B·2B + w3B·3B + wHR·HR)
 *        / (AB + BB − IBB + SF + HBP)
 * uBB = unintentional walks (IBB excluded from the numerator event).
 */
export function woba(line: RawBattingLine, c: LeagueConstants): number | null {
  const uBB = line.baseOnBalls - num(line.intentionalWalks);
  const numer =
    c.wBB * uBB +
    c.wHBP * num(line.hitByPitch) +
    c.w1B * singles(line) +
    c.w2B * line.doubles +
    c.w3B * line.triples +
    c.wHR * line.homeRuns;
  const denom =
    line.atBats +
    line.baseOnBalls -
    num(line.intentionalWalks) +
    num(line.sacFlies) +
    num(line.hitByPitch);
  return rate(numer, denom);
}

/** wRAA = ((wOBA − lgwOBA) / wOBAScale) · PA */
export function wraa(
  wobaValue: number | null,
  pa: number,
  c: LeagueConstants,
): number | null {
  if (wobaValue === null) return null;
  return ((wobaValue - c.wOBA) / c.wOBAScale) * pa;
}

/** wRC = (((wOBA − lgwOBA) / wOBAScale) + lgR/PA) · PA */
export function wrc(
  wobaValue: number | null,
  pa: number,
  c: LeagueConstants,
): number | null {
  if (wobaValue === null) return null;
  return ((wobaValue - c.wOBA) / c.wOBAScale + c.runsPerPA) * pa;
}

/**
 * wRC+ (park-neutral form) = 100 · (wRAA/PA + lgR/PA) / lgR/PA.
 * Park factors would enter here in a full implementation; v1 treats the park
 * as neutral at the team-season level and applies venue adjustments downstream
 * in the run model instead of double-counting them.
 */
export function wrcPlus(
  wobaValue: number | null,
  pa: number,
  c: LeagueConstants,
): number | null {
  const raa = wraa(wobaValue, pa, c);
  if (raa === null || pa === 0 || c.runsPerPA === 0) return null;
  return 100 * ((raa / pa + c.runsPerPA) / c.runsPerPA);
}

export function computeBattingMetrics(
  line: RawBattingLine,
  season: number,
): BattingMetrics {
  const c = getLeagueConstants(season);
  const pa = plateAppearances(line);
  const wobaValue = woba(line, c);
  const avgValue = avg(line);
  const slgValue = slg(line);
  const obpValue = obp(line);

  // BABIP = (H − HR) / (AB − K − HR + SF)
  const babip =
    line.strikeOuts === undefined
      ? null
      : rate(
          line.hits - line.homeRuns,
          line.atBats - line.strikeOuts - line.homeRuns + num(line.sacFlies),
        );

  return {
    season: c.season,
    plateAppearances: pa,
    avg: round(avgValue, 3),
    obp: round(obpValue, 3),
    slg: round(slgValue, 3),
    ops:
      obpValue === null || slgValue === null
        ? null
        : round(obpValue + slgValue, 3),
    iso:
      avgValue === null || slgValue === null
        ? null
        : round(slgValue - avgValue, 3),
    woba: round(wobaValue, 3),
    wraa: round(wraa(wobaValue, pa, c), 1),
    wrc: round(wrc(wobaValue, pa, c), 1),
    wrcPlus: round(wrcPlus(wobaValue, pa, c), 0),
    kPct: round(rate(num(line.strikeOuts), pa), 3),
    bbPct: round(rate(line.baseOnBalls, pa), 3),
    babip: round(babip, 3),
  };
}
