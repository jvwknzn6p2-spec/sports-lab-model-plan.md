/**
 * Defense-independent pitching metrics (the FIP family).
 *
 * Project policy: we rank and model pitchers by FIP/xFIP, NOT ERA. ERA is
 * retained only as a descriptive reference. Rationale:
 *   - ERA folds in team defense, sequencing luck, and bullpen inheritance —
 *     none of which the starter controls and none of which predict future runs.
 *   - FIP isolates the three true outcomes a pitcher owns (K, BB/HBP, HR) and
 *     is markedly more predictive of a pitcher's next-game run prevention.
 *   - xFIP further normalizes home runs to a league fly-ball rate, stripping
 *     the noisiest component (HR/FB) for small in-season samples.
 *
 * All rate stats derive from OUTS (see units.ts), so "180.1" IP is 180⅓.
 */

import { getLeagueConstants, type LeagueConstants } from "./constants";
import { inningsToDecimal, inningsToOuts, rate, round } from "./units";

/** Raw pitching counting stats, as pulled from a stat source. */
export interface RawPitchingLine {
  /** Innings pitched, either "180.1" MLB notation or decimal thirds. */
  readonly inningsPitched: string | number;
  readonly battersFaced?: number;
  readonly strikeOuts: number;
  readonly baseOnBalls: number;
  readonly hitByPitch?: number;
  readonly homeRuns: number;
  readonly hits?: number;
  readonly earnedRuns?: number;
  readonly runs?: number;
  /** Batted-ball detail (optional; enables xFIP and GB/FB context). */
  readonly flyBalls?: number;
  readonly groundBalls?: number;
  readonly atBats?: number;
  readonly sacFlies?: number;
}

export interface PitchingMetrics {
  season: number;
  outs: number;
  inningsPitched: number;
  battersFaced: number | null;
  /** Core defense-independent estimators (ERA scale, lower is better). */
  fip: number | null;
  xfip: number | null;
  kwera: number | null;
  /** FIP indexed to the league (100 = average, <100 is better). */
  fipMinus: number | null;
  /** Descriptive reference only — not used for ranking. */
  era: number | null;
  whip: number | null;
  // Per-9 rates.
  k9: number | null;
  bb9: number | null;
  hr9: number | null;
  h9: number | null;
  // Plate-appearance rates.
  kPct: number | null;
  bbPct: number | null;
  kMinusBbPct: number | null;
  // Luck / batted-ball context.
  babip: number | null;
  lobPct: number | null;
  hrPerFB: number | null;
  /** Whether xFIP fell back to a league fly-ball estimate (no batted-ball data). */
  xfipEstimated: boolean;
}

const num = (v: number | undefined): number => v ?? 0;

/**
 * FIP = ((13·HR + 3·(BB+HBP) − 2·K) / IP) + cFIP
 * Put on the ERA scale by the season's FIP constant.
 */
export function fip(line: RawPitchingLine, c: LeagueConstants): number | null {
  const ip = inningsToDecimal(line.inningsPitched);
  const raw = rate(
    13 * line.homeRuns +
      3 * (line.baseOnBalls + num(line.hitByPitch)) -
      2 * line.strikeOuts,
    ip,
  );
  return raw === null ? null : raw + c.cFIP;
}

/**
 * xFIP = ((13·(FB·lgHR/FB) + 3·(BB+HBP) − 2·K) / IP) + cFIP
 * Replaces actual HR with fly balls × league HR/FB rate. When batted-ball data
 * is unavailable we estimate expected fly balls from IP so xFIP still computes,
 * and flag it via `xfipEstimated`.
 */
export function xfip(
  line: RawPitchingLine,
  c: LeagueConstants,
): { value: number | null; estimated: boolean } {
  const ip = inningsToDecimal(line.inningsPitched);
  let flyBalls = line.flyBalls;
  let estimated = false;
  if (flyBalls === undefined) {
    // League-average fly balls per inning (~1.05 FB/IP historically).
    flyBalls = ip * 1.05;
    estimated = true;
  }
  const expectedHR = flyBalls * c.hrPerFB;
  const raw = rate(
    13 * expectedHR +
      3 * (line.baseOnBalls + num(line.hitByPitch)) -
      2 * line.strikeOuts,
    ip,
  );
  return { value: raw === null ? null : raw + c.cFIP, estimated };
}

/**
 * kwERA = 5.40 − 12 · (K − BB) / PA
 * A pure strikeout-minus-walk ERA estimator; usable when HR data is missing or
 * as a low-variance cross-check on FIP.
 */
export function kwera(
  line: RawPitchingLine,
  tbf: number | null,
): number | null {
  if (tbf === null || tbf === 0) return null;
  return 5.4 - 12 * ((line.strikeOuts - line.baseOnBalls) / tbf);
}

/** FIP- = 100 · (FIP · (2 − PF/100)) / lgFIP. PF centered at 100 (neutral). */
export function fipMinus(
  fipValue: number | null,
  c: LeagueConstants,
  parkFactor = 100,
): number | null {
  if (fipValue === null || c.lgFIP === 0) return null;
  return 100 * ((fipValue * (2 - parkFactor / 100)) / c.lgFIP);
}

/** Total batters faced, estimated from a stat line if not provided directly. */
export function battersFaced(line: RawPitchingLine): number | null {
  if (line.battersFaced !== undefined) return line.battersFaced;
  // PA ≈ outs + hits + walks + HBP  (approximation when TBF is absent).
  if (line.hits === undefined) return null;
  return (
    inningsToOuts(line.inningsPitched) +
    line.hits +
    line.baseOnBalls +
    num(line.hitByPitch)
  );
}

/** Compute the full FIP-forward metric set for a pitching line. */
export function computePitchingMetrics(
  line: RawPitchingLine,
  season: number,
): PitchingMetrics {
  const c = getLeagueConstants(season);
  const outs = inningsToOuts(line.inningsPitched);
  const ip = inningsToDecimal(line.inningsPitched);
  const tbf = battersFaced(line);
  const fipValue = fip(line, c);
  const xfipResult = xfip(line, c);

  const hits = line.hits;
  const earned = line.earnedRuns;
  const runs = line.runs;

  // BABIP (pitcher) = (H − HR) / (AB − K − HR + SF)
  const babipDenom =
    line.atBats !== undefined && hits !== undefined
      ? line.atBats - line.strikeOuts - line.homeRuns + num(line.sacFlies)
      : null;
  const babip =
    babipDenom === null || hits === undefined
      ? null
      : rate(hits - line.homeRuns, babipDenom);

  // LOB% = (H + BB + HBP − R) / (H + BB + HBP − 1.4·HR)
  const onBase =
    hits === undefined ? null : hits + line.baseOnBalls + num(line.hitByPitch);
  const lobPct =
    onBase === null || runs === undefined
      ? null
      : rate(onBase - runs, onBase - 1.4 * line.homeRuns);

  const hrPerFB =
    line.flyBalls !== undefined && line.flyBalls > 0
      ? line.homeRuns / line.flyBalls
      : null;

  return {
    season: c.season,
    outs,
    inningsPitched: round(ip)!,
    battersFaced: tbf,
    fip: round(fipValue, 2),
    xfip: round(xfipResult.value, 2),
    kwera: round(kwera(line, tbf), 2),
    fipMinus: round(fipMinus(fipValue, c), 0),
    era: round(earned === undefined ? null : rate(9 * earned, ip), 2),
    whip:
      hits === undefined ? null : round(rate(line.baseOnBalls + hits, ip), 2),
    k9: round(rate(9 * line.strikeOuts, ip), 2),
    bb9: round(rate(9 * line.baseOnBalls, ip), 2),
    hr9: round(rate(9 * line.homeRuns, ip), 2),
    h9: hits === undefined ? null : round(rate(9 * hits, ip), 2),
    kPct: round(rate(line.strikeOuts, tbf ?? 0), 3),
    bbPct: round(rate(line.baseOnBalls, tbf ?? 0), 3),
    kMinusBbPct: round(rate(line.strikeOuts - line.baseOnBalls, tbf ?? 0), 3),
    babip: round(babip, 3),
    lobPct: round(lobPct, 3),
    hrPerFB: round(hrPerFB, 3),
    xfipEstimated: xfipResult.estimated,
  };
}
