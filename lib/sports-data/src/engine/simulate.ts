/**
 * Monte Carlo game simulator (plan Section 4.2).
 *
 * Each simulated game draws team runs from a NEGATIVE BINOMIAL (not a plain
 * Poisson), under a shared game-environment factor; ties are broken by
 * simulated extra innings (per-inning Poisson at the environment-adjusted
 * mu/9). Seeded → the same game + date always yields identical probabilities
 * (reproducible locks).
 *
 * ## Why not independent Poisson
 *
 * The first version drew each team's runs as independent Poisson(mu), and the
 * settled record exposed both of that model's known defects at once: picks
 * quoted at 65–70% hit 42% (n=19), while the 55–60% band ran ahead of its
 * quote. Two things are wrong with independent Poisson for baseball:
 *
 *   1. UNDERDISPERSION — real team runs, even conditional on the matchup,
 *      have variance ≈ 1.5× the mean (innings blow up; bullpens implode).
 *      Poisson forces variance = mean.
 *   2. INDEPENDENCE — both teams bat in the same park, weather, and umpire
 *      zone, so their run totals are positively correlated (ρ ≈ 0.1).
 *
 * Both errors shrink the spread of the MARGIN, and a margin distribution
 * that is too narrow pays out as overconfidence exactly in the tails — the
 * favourite "wins by enough" too often in the simulation and not often
 * enough on the field.
 *
 * The fix, in the standard sports-modelling form:
 *
 *   e      ~ Gamma(k, 1/k)            shared environment, mean 1, sd ~20%
 *   runs_i ~ NegBin(mu_i · e, r)      per team, variance mu + mu²/r
 *
 * With r = 9 and sd(e) = 0.2 at mu = 4.5: team-run variance ≈ 7.5 (ratio
 * ~1.65 vs the ~1.5–2.0 seen in MLB data) and corr(home, away) ≈ +0.11 —
 * both inside the empirically observed ranges, and the margin's standard
 * deviation widens from 3.0 (Poisson) to ≈ 3.6, which is what pulls the
 * simulated tail probabilities back toward what actually happens.
 */

import {
  gamma,
  mulberry32,
  negBinomial,
  poisson,
  seedFromString,
  type Rng,
} from "./rng";
import { settleParts, splitLine, type WeightedLine } from "./handicap-notation";

/**
 * Negative-binomial size for one team's runs: variance = mu + mu²/r.
 *
 * r = 4.5 is MEASURED, not assumed. Three walk-forward backtests over the
 * real MLB record (2,976 games: 2024-05→08, 2025-05→06, 2025-07→08) put the
 * margin-residual variance at 1.46–1.58× what r = 9 produced. Re-running the
 * same three periods at r = 4.5 with no shared factor closed that gap in
 * every one of them (ratios 1.12 / 1.20 / 1.14), the calibration gap shrank
 * in all three (1.0→0.0, 2.9→0.9, 2.4→2.2 pt) and Brier held or improved.
 */
export const TEAM_RUN_DISPERSION = 4.5;

/**
 * Standard deviation of the shared game-environment multiplier (park, wind,
 * temperature, umpire — everything both offenses live in together).
 *
 * ZERO, because the real record says so. The original 0.2 came from the
 * literature's ~0.1 same-game run correlation, but the RESIDUAL correlation
 * measured across those same 2,976 games is +0.035 / −0.007 / −0.008 —
 * indistinguishable from zero in every period. Whatever shared conditions do
 * to a game, the run model's park factor and matchup terms already absorb;
 * modelling it again invented a correlation the data does not have.
 *
 * The mechanism stays in the simulator (and under test) behind this
 * constant: if a future measurement finds real residual correlation, it is
 * one number away from coming back.
 */
export const SHARED_ENV_SD = 0;

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
  /**
   * Push-excluded over/under probabilities, plus the share of simulations
   * that land exactly on the line (`push`). A whole-number total returns the
   * stake on the exact score, so pricing the bet needs the push share as well
   * as the conditional probability — exactly as `asianCover` reports for run
   * lines. Zero for any half-run line.
   */
  totalProb: (line: number) => { over: number; under: number; push: number };
}

export interface SimulateOptions {
  sims?: number;
  seed?: string | number;
  /**
   * Negative-binomial size for team runs (variance = mu + mu²/size).
   * `Infinity` recovers the old independent-Poisson behaviour; exposed for
   * tests and sensitivity checks, not for daily use.
   */
  dispersion?: number;
  /** Sd of the shared game-environment multiplier; 0 disables it. */
  envSd?: number;
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

function playExtras(
  h: number,
  a: number,
  muH: number,
  muA: number,
  rng: Rng,
): [number, number] {
  // Callers pass the ENVIRONMENT-ADJUSTED mus, so extra innings are played in
  // the same conditions as the regulation innings that produced the tie.
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
  const dispersion = opts.dispersion ?? TEAM_RUN_DISPERSION;
  const envSd = opts.envSd ?? SHARED_ENV_SD;
  // NaN is not a parameter, it is a bug upstream — and the quietest possible
  // one: `negBinomial` reads it as "no dispersion" and answers with a plain
  // Poisson, so the caller silently gets the PRE-REFIT engine and no error.
  // (Infinity is allowed on purpose: it IS the Poisson limit of the negative
  // binomial, and asking for it explicitly is how the baseline is measured.)
  if (Number.isNaN(dispersion) || dispersion <= 0) {
    throw new Error(`simulateGame: dispersion must be a positive number (got ${dispersion})`);
  }
  if (!Number.isFinite(envSd) || envSd < 0) {
    throw new Error(`simulateGame: envSd must be a non-negative finite number (got ${envSd})`);
  }
  // Gamma(k, 1/k) has mean 1 and sd 1/√k, so k = 1/sd².
  const envShape = envSd > 0 ? 1 / (envSd * envSd) : null;

  const margins: number[] = new Array(sims);
  const totals: number[] = new Array(sims);
  let homeWins = 0;
  let sumH = 0;
  let sumA = 0;

  for (let i = 0; i < sims; i++) {
    // ONE environment draw per game, applied to BOTH teams — this shared
    // factor is what makes the two run totals positively correlated.
    const env = envShape === null ? 1 : gamma(envShape, rng) / envShape;
    const muH = homeMu * env;
    const muA = awayMu * env;
    let h = negBinomial(muH, dispersion, rng);
    let a = negBinomial(muA, dispersion, rng);
    if (h === a) [h, a] = playExtras(h, a, muH, muA, rng);
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
    // settleParts is the same rule settlement uses on the real score, so a
    // quoted price and its eventual result can never disagree about a push.
    const parts = typeof line === "number" ? splitLine(line) : line;
    let win = 0;
    let push = 0;
    let loss = 0;
    for (const m of margins) {
      const s = settleParts(parts, side === "home" ? m : -m);
      win += s.win;
      push += s.push;
      loss += s.loss;
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
      push: push / sims,
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
