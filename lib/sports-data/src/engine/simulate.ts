/**
 * Monte Carlo game simulator (plan Section 4.2).
 *
 * Draws each team's runs from Poisson(mu) thousands of times; ties are broken
 * by simulated extra innings (per-inning Poisson at mu/9). Seeded → the same
 * game + date always yields identical probabilities (reproducible locks).
 */

import { mulberry32, poisson, seedFromString, type Rng } from "./rng";
import type { WeightedLine } from "./handicap-notation";

export interface SimulationResult {
  sims: number;
  pHomeWin: number;
  pAwayWin: number;
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
  asianCover: (
    side: "home" | "away",
    line: number | readonly WeightedLine[],
  ) => AsianCover;
  /** Push-excluded cover probability — the number to quote and calibrate. */
  coverProb: (
    side: "home" | "away",
    line: number | readonly WeightedLine[],
  ) => number;
  totalProb: (line: number) => { over: number; under: number };
}

export interface SimulateOptions {
  sims?: number;
  seed?: string | number;
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
 * Split a bare number into the sub-lines it is really made of. A quarter line
 * (x.25 / x.75) is half a stake on each neighbouring half-line; everything
 * else is a single full-stake line.
 *
 * Japanese 半 notation produces UNEVEN splits (see handicap-notation.ts), so
 * `asianCover` also accepts pre-weighted parts directly and only falls back to
 * this when handed a plain number.
 */
function subLines(line: number): WeightedLine[] {
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
): [number, number] {
  for (let i = 0; i < MAX_EXTRA_INNINGS && h === a; i++) {
    h += poisson(muH / 9, rng);
    a += poisson(muA / 9, rng);
  }
  if (h === a) {
    // MLB plays on until someone wins: break a pathological tie streak with a
    // coin weighted by run expectation.
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

  const margins: number[] = new Array(sims);
  const totals: number[] = new Array(sims);
  let homeWins = 0;
  let sumH = 0;
  let sumA = 0;

  for (let i = 0; i < sims; i++) {
    let h = poisson(homeMu, rng);
    let a = poisson(awayMu, rng);
    if (h === a) [h, a] = playExtras(h, a, homeMu, awayMu, rng);
    if (h > a) homeWins++;
    margins[i] = h - a;
    totals[i] = h + a;
    sumH += h;
    sumA += a;
  }

  const asianCover = (
    side: "home" | "away",
    line: number | readonly WeightedLine[],
  ): AsianCover => {
    // side+line in sportsbook convention: home -1.5 covers if margin > 1.5;
    // away +1.5 covers if (away margin + 1.5) > 0, i.e. home margin < 1.5.
    const parts = typeof line === "number" ? subLines(line) : line;
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

  const coverProb = (
    side: "home" | "away",
    line: number | readonly WeightedLine[],
  ): number => asianCover(side, line).probability;

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

  return {
    sims,
    pHomeWin: homeWins / sims,
    pAwayWin: 1 - homeWins / sims,
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
