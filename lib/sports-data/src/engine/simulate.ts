/**
 * Monte Carlo game simulator (plan Section 4.2).
 *
 * Draws each team's runs from Poisson(mu) thousands of times; ties are broken
 * by simulated extra innings (per-inning Poisson at mu/9). Seeded → the same
 * game + date always yields identical probabilities (reproducible locks).
 */

import { mulberry32, poisson, seedFromString, type Rng } from "./rng";

export interface SimulationResult {
  sims: number;
  /** Push-excluded: P(home wins | the game is decided). */
  pHomeWin: number;
  pAwayWin: number;
  /** P(the game ends tied). Always 0 for MLB. */
  pTie: number;
  meanHomeRuns: number;
  meanAwayRuns: number;
  meanTotal: number;
  meanMargin: number; // home − away
  /** P(home margin > 1.5) and P(away keeps it within 1.5 or wins). */
  pHomeCoverMinus15: number;
  pAwayCoverPlus15: number;
  /**
   * Asian-handicap settlement for an arbitrary line, including pushes and the
   * half-stake split of quarter lines.
   */
  asianCover: (side: "home" | "away", line: number) => AsianCover;
  /** Push-excluded cover probability — the number to quote and calibrate. */
  coverProb: (side: "home" | "away", line: number) => number;
  totalProb: (line: number) => { over: number; under: number };
}

/**
 * The only rule difference that matters to the model.
 *
 * MLB plays extra innings until someone wins, so a settled game always has a
 * winner. NPB stops, so a tie is a real outcome — which makes the moneyline a
 * push rather than a loss, and makes a level (0) handicap pushable. Everything
 * downstream — the handicap grid, the settlement, the calibration — is
 * identical between the two leagues; only this changes.
 */
export type League = "MLB" | "NPB";

export interface SimulateOptions {
  sims?: number;
  seed?: string | number;
  league?: League;
  /**
   * Extra innings played before a tie is allowed to stand. Defaults to
   * unlimited for MLB and none for NPB. NPB's real limit has moved over the
   * years (12 innings currently, 10 in 2020-21, none in some seasons), so it
   * is configurable rather than hardcoded.
   */
  maxExtraInnings?: number;
}

const MAX_EXTRA_INNINGS = 30;

/**
 * How an Asian handicap actually settles.
 *
 * A run line is not a coin with two sides. On a whole-number line the exact
 * margin returns the stake (a push), and on a quarter line the stake is split
 * across the two neighbouring half-lines, so half of it can win while the
 * other half pushes. Treating either case as a plain loss — which the earlier
 * strict `margin + line > 0` test did — understates every whole-number and
 * quarter line the market actually offers.
 */
export interface AsianCover {
  /** Share of the stake that wins outright. */
  win: number;
  /** Share returned (push). */
  push: number;
  /** Share lost. */
  loss: number;
  /** win / (win + loss) — the honest quote once pushes are set aside. */
  probability: number;
}

/**
 * Split a line into the sub-lines it is really made of. A quarter line
 * (x.25 / x.75) is half a stake on each neighbouring half-line; everything
 * else is a single full-stake line.
 */
function subLines(line: number): Array<{ line: number; weight: number }> {
  const quarter = Math.abs(line * 4 - Math.round(line * 4)) < 1e-9;
  const half = Math.abs(line * 2 - Math.round(line * 2)) < 1e-9;
  if (quarter && !half) {
    return [
      { line: line - 0.25, weight: 0.5 },
      { line: line + 0.25, weight: 0.5 },
    ];
  }
  return [{ line, weight: 1 }];
}

function playExtras(
  h: number,
  a: number,
  muH: number,
  muA: number,
  rng: Rng,
  maxExtra: number,
  forceDecision: boolean,
): [number, number] {
  for (let i = 0; i < maxExtra && h === a; i++) {
    h += poisson(muH / 9, rng);
    a += poisson(muA / 9, rng);
  }
  if (h === a && forceDecision) {
    // MLB cannot end level: break a pathological tie streak with a coin
    // weighted by run expectation.
    if (rng() < muH / (muH + muA)) h += 1;
    else a += 1;
  }
  return [h, a];
}

export function simulateGame(
  homeMu: number,
  awayMu: number,
  opts: SimulateOptions = {},
): SimulationResult {
  const sims = opts.sims ?? 10_000;
  const seed =
    typeof opts.seed === "number"
      ? opts.seed
      : seedFromString(String(opts.seed ?? "handiedge"));
  const rng = mulberry32(seed);
  const league: League = opts.league ?? "MLB";
  const maxExtra =
    opts.maxExtraInnings ?? (league === "MLB" ? MAX_EXTRA_INNINGS : 0);

  const margins: number[] = new Array(sims);
  const totals: number[] = new Array(sims);
  let homeWins = 0;
  let ties = 0;
  let sumH = 0;
  let sumA = 0;

  for (let i = 0; i < sims; i++) {
    let h = poisson(homeMu, rng);
    let a = poisson(awayMu, rng);
    if (h === a) {
      [h, a] = playExtras(
        h,
        a,
        homeMu,
        awayMu,
        rng,
        maxExtra,
        league === "MLB",
      );
    }
    if (h === a) ties++;
    if (h > a) homeWins++;
    margins[i] = h - a;
    totals[i] = h + a;
    sumH += h;
    sumA += a;
  }

  const asianCover = (side: "home" | "away", line: number): AsianCover => {
    // side+line in sportsbook convention: home -1.5 covers if margin > 1.5;
    // away +1.5 covers if (away margin + 1.5) > 0, i.e. home margin < 1.5.
    const parts = subLines(line);
    let win = 0;
    let push = 0;
    let loss = 0;
    for (const m of margins) {
      const sideMargin = side === "home" ? m : -m;
      for (const part of parts) {
        const settled = sideMargin + part.line;
        if (settled > 0) win += part.weight;
        else if (settled === 0) push += part.weight;
        else loss += part.weight;
      }
    }
    win /= sims;
    push /= sims;
    loss /= sims;
    const decided = win + loss;
    return {
      win,
      push,
      loss,
      probability: decided === 0 ? 0.5 : win / decided,
    };
  };

  const coverProb = (side: "home" | "away", line: number): number =>
    asianCover(side, line).probability;

  const totalProb = (line: number) => {
    let over = 0;
    let push = 0;
    for (const t of totals) {
      if (t > line) over++;
      else if (t === line) push++;
    }
    const decided = sims - push;
    return {
      over: decided === 0 ? 0.5 : over / decided,
      under: decided === 0 ? 0.5 : (decided - over) / decided,
    };
  };

  // A tie is a push on the moneyline: stake returned, so it belongs in
  // neither column. Quote the probability over decided games only — the same
  // convention the handicap and total already use.
  const decidedGames = sims - ties;
  return {
    sims,
    pHomeWin: decidedGames === 0 ? 0.5 : homeWins / decidedGames,
    pAwayWin:
      decidedGames === 0 ? 0.5 : (decidedGames - homeWins) / decidedGames,
    pTie: ties / sims,
    meanHomeRuns: sumH / sims,
    meanAwayRuns: sumA / sims,
    meanTotal: (sumH + sumA) / sims,
    meanMargin: (sumH - sumA) / sims,
    pHomeCoverMinus15: coverProb("home", -1.5),
    pAwayCoverPlus15: coverProb("away", 1.5),
    asianCover,
    coverProb,
    totalProb,
  };
}
