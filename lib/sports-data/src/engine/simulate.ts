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
  pHomeWin: number;
  pAwayWin: number;
  meanHomeRuns: number;
  meanAwayRuns: number;
  meanTotal: number;
  meanMargin: number; // home − away
  /** P(home margin > 1.5) and P(away keeps it within 1.5 or wins). */
  pHomeCoverMinus15: number;
  pAwayCoverPlus15: number;
  /** P(margin from the HOME side clears an arbitrary handicap line). */
  coverProb: (side: "home" | "away", line: number) => number;
  totalProb: (line: number) => { over: number; under: number };
}

export interface SimulateOptions {
  sims?: number;
  seed?: string | number;
}

const MAX_EXTRA_INNINGS = 30;

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
    // Pathological tie streak: weighted coin by run expectation.
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

  const coverProb = (side: "home" | "away", line: number): number => {
    // side+line in sportsbook convention: home -1.5 covers if margin > 1.5;
    // away +1.5 covers if (away margin + 1.5) > 0, i.e. home margin < 1.5.
    let n = 0;
    for (const m of margins) {
      const sideMargin = side === "home" ? m : -m;
      if (sideMargin + line > 0) n++;
    }
    return n / sims;
  };

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
    coverProb,
    totalProb,
  };
}
