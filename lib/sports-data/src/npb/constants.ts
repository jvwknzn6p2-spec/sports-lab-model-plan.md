/**
 * NPB league constants — DERIVED from npb.jp league totals, never copied
 * from MLB and never typed in from memory.
 *
 * FanGraphs publishes no "Guts!" for NPB, so every environment number the
 * sabermetrics layer needs is computed from the two team-aggregate tables
 * fetched the same morning (tmb_* and tmp_*, both leagues pooled):
 *
 *   runsPerPA    = ΣR / ΣPA                         (exact)
 *   lgFIP        = ΣER / ΣIP × 9  (league ERA)      (exact)
 *   cFIP         = lgERA − (13·HR + 3·(BB+HBP) − 2·K)/IP   (exact — the
 *                  standard FIP constant construction, on NPB's own totals)
 *   hrPerFB      = ΣHR / (ΣIP × 1.05)               (the same league
 *                  fly-ball estimate the xFIP fallback uses, so an NPB
 *                  xFIP with no batted-ball data reduces to FIP with the
 *                  HR term regressed to the NPB league rate — exactly the
 *                  documented MLB behaviour, on NPB's numbers)
 *   wOBA (mean)  = weights applied to the league's own totals
 *
 * The wOBA event WEIGHTS themselves (wBB…wHR) are the one approximation:
 * exact linear weights need a play-by-play run-expectancy matrix npb.jp
 * does not publish. The MLB weights of the requested season are used AS
 * WEIGHTS ONLY, while every anchor (league mean wOBA, runsPerPA, FIP
 * family) is NPB-derived. Feature builders regress each club toward the
 * NPB league mean computed with the same weights, so club-vs-club
 * comparisons — all the run model consumes — are internally consistent.
 * Both leagues are pooled deliberately: the DH gap between Central and
 * Pacific shows up in club wOBA differences, which is where the model
 * reads it.
 *
 * The derived object is stamped with a synthetic season key (1000000 +
 * year) and persisted INSIDE the slate bundle, so predict re-registers the
 * exact constants the slate was built with — reproducible, auditable, and
 * never colliding with an MLB season number.
 */

import {
  getLeagueConstants,
  inningsToDecimal,
  type LeagueConstants,
  type RawBattingLine,
  type RawPitchingLine,
} from "../sabermetrics";

/** Synthetic season key for NPB constants: 1000000 + calendar year. */
export function npbSeasonKey(year: number): number {
  return 1_000_000 + year;
}

/** The calendar year a (possibly synthetic) season key refers to. */
export function seasonYear(seasonKey: number): number {
  return seasonKey > 1_000_000 ? seasonKey - 1_000_000 : seasonKey;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function deriveNpbConstants(
  year: number,
  teamBatting: RawBattingLine[],
  teamPitching: RawPitchingLine[],
  leagueRuns: number,
): LeagueConstants {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const pa = sum(teamBatting.map((b) => b.plateAppearances ?? 0));
  const ab = sum(teamBatting.map((b) => b.atBats));
  const h = sum(teamBatting.map((b) => b.hits));
  const d2 = sum(teamBatting.map((b) => b.doubles));
  const d3 = sum(teamBatting.map((b) => b.triples));
  const hrBat = sum(teamBatting.map((b) => b.homeRuns));
  const bb = sum(teamBatting.map((b) => b.baseOnBalls));
  const ibb = sum(teamBatting.map((b) => b.intentionalWalks ?? 0));
  const hbp = sum(teamBatting.map((b) => b.hitByPitch ?? 0));
  const sf = sum(teamBatting.map((b) => b.sacFlies ?? 0));

  const ip = sum(teamPitching.map((p) => inningsToDecimal(p.inningsPitched)));
  const er = sum(teamPitching.map((p) => p.earnedRuns ?? 0));
  const k = sum(teamPitching.map((p) => p.strikeOuts));
  const bbP = sum(teamPitching.map((p) => p.baseOnBalls));
  const hbpP = sum(teamPitching.map((p) => p.hitByPitch ?? 0));
  const hrP = sum(teamPitching.map((p) => p.homeRuns));

  if (pa === 0 || ip === 0) {
    throw new Error("NPB constants: league totals are empty");
  }

  // Weights borrowed from the MLB season (see module doc); anchors NPB-own.
  const w = getLeagueConstants(year);
  const singles = h - d2 - d3 - hrBat;
  const wobaNum =
    w.wBB * (bb - ibb) +
    w.wHBP * hbp +
    w.w1B * singles +
    w.w2B * d2 +
    w.w3B * d3 +
    w.wHR * hrBat;
  const wobaDen = ab + bb - ibb + sf + hbp;
  const lgWoba = wobaNum / wobaDen;

  const lgEra = (er / ip) * 9;
  const fipCore = (13 * hrP + 3 * (bbP + hbpP) - 2 * k) / ip;

  return {
    season: npbSeasonKey(year),
    wOBA: round3(lgWoba),
    wOBAScale: w.wOBAScale,
    wBB: w.wBB,
    wHBP: w.wHBP,
    w1B: w.w1B,
    w2B: w.w2B,
    w3B: w.w3B,
    wHR: w.wHR,
    runSB: w.runSB,
    runCS: w.runCS,
    runsPerPA: round3(leagueRuns / pa),
    runsPerWin: w.runsPerWin,
    cFIP: round3(lgEra - fipCore),
    lgFIP: round3(lgEra),
    hrPerFB: round3(hrP / (ip * 1.05)),
  };
}
