/**
 * The Monte Carlo game simulator (model-plan.md §4.2, build step 5).
 *
 * Input: expected runs per team from the baseline model.
 * Output: the joint distribution of final scores.
 *
 * ## Why a joint distribution rather than three probabilities
 *
 * The obvious implementation counts three things while simulating — wins,
 * margin ≥ 2, total > line — and returns them. That works right up until you
 * want to price a handicap the book actually offers (−1.0, +0.5, −0.75) or a
 * total other than the one you hard-coded, at which point you have to
 * re-simulate. Keeping the full `P(home = i, away = j)` matrix costs a few
 * kilobytes and lets every market be priced analytically afterwards, exactly,
 * from one simulation run.
 *
 * ## The run model
 *
 * Runs per team are drawn from a negative binomial, built as a Gamma–Poisson
 * mixture so the game-level randomness can be decomposed:
 *
 *     lambda_i = mu_i x environment x form_i
 *     runs_i   ~ Poisson(lambda_i)
 *
 * `environment` is shared by both teams (wind, park, altitude, strike zone) and
 * is what induces the observed positive correlation between the two scores.
 * `form_i` is that team's own day-to-day noise. Both are Gamma variates with
 * mean 1, so the baseline model's expected runs pass through untouched — this
 * layer only adds the right amount of spread, never shifts the forecast.
 *
 * Regulation scores are then adjusted for two rules that a "just draw two
 * numbers" simulator gets wrong, and which both bias totals upward: the home
 * team not batting in the ninth when ahead, and extra innings.
 */

import { Rng, hashString } from "./rng.ts";
import {
  DEFAULT_CONFIG,
  type ExpectedRuns,
  type ScoreDistribution,
  type SimulationConfig,
} from "./types.ts";

/**
 * Splits total run variance into a shared "environment" component and a
 * per-team component that together hit both the requested dispersion and the
 * requested correlation.
 *
 * Given target variance `var_i = mu_i + mu_i^2 / k` and target correlation
 * `rho`, the shared factor must satisfy `cov = mu_h * mu_a / kEnv`, and the two
 * concentrations compose as `(1 + 1/k) = (1 + 1/kEnv)(1 + 1/kTeam)`.
 */
export function solveDispersion(
  dispersionK: number,
  correlation: number,
  mu: ExpectedRuns,
): { environment: number; team: number; correlationApplied: number } {
  if (!(dispersionK > 0)) {
    throw new RangeError(`dispersionK must be > 0, got ${dispersionK}`);
  }
  if (correlation <= 0 || mu.home <= 0 || mu.away <= 0) {
    return { environment: Infinity, team: dispersionK, correlationApplied: 0 };
  }

  const varHome = mu.home + (mu.home * mu.home) / dispersionK;
  const varAway = mu.away + (mu.away * mu.away) / dispersionK;
  const product = mu.home * mu.away;

  // All of the variance can at most come from the shared factor, which caps how
  // much correlation is reachable without changing the requested dispersion.
  const maxCorrelation = product / (dispersionK * Math.sqrt(varHome * varAway));
  const rho = Math.min(correlation, maxCorrelation * 0.999);

  const environment = product / (rho * Math.sqrt(varHome * varAway));
  const teamInverse = (1 + 1 / dispersionK) / (1 + 1 / environment) - 1;

  return {
    environment,
    team: teamInverse <= 0 ? Infinity : 1 / teamInverse,
    correlationApplied: rho,
  };
}

/** Stable hash of everything that affects the output, for cache keys and drift tracking. */
function hashInputs(expected: ExpectedRuns, config: SimulationConfig): string {
  const canonical = JSON.stringify([
    expected.home,
    expected.away,
    config.sims,
    String(config.seed),
    config.dispersionK,
    config.environmentCorrelation,
    config.homeNinthTruncation,
    config.extraInningBoost,
    config.maxExtraInnings,
    config.maxRuns,
  ]);
  return hashString(canonical).toString(16).padStart(8, "0");
}

/**
 * Simulate one game `sims` times and return the joint distribution of scores.
 *
 * `expected` comes straight from the baseline model. Everything else has a
 * sensible MLB-calibrated default; `seed` is the only required option.
 */
export function simulateGame(
  expected: ExpectedRuns,
  options: Partial<SimulationConfig> & Pick<SimulationConfig, "seed">,
): ScoreDistribution {
  const config: SimulationConfig = { ...DEFAULT_CONFIG, ...options };

  if (!(expected.home >= 0) || !(expected.away >= 0)) {
    throw new RangeError(
      `expected runs must be >= 0, got home=${expected.home} away=${expected.away}`,
    );
  }
  if (!Number.isInteger(config.sims) || config.sims < 1) {
    throw new RangeError(`sims must be a positive integer, got ${config.sims}`);
  }

  const rng = new Rng(config.seed);
  const { environment, team } = solveDispersion(
    config.dispersionK,
    config.environmentCorrelation,
    expected,
  );

  const stride = config.maxRuns + 1;
  const joint = new Int32Array(stride * stride);

  let overflow = 0;
  let forcedResolutions = 0;
  let extraInningGames = 0;
  let sumHome = 0;
  let sumAway = 0;
  let sumHomeSq = 0;
  let sumAwaySq = 0;
  let sumProduct = 0;

  for (let n = 0; n < config.sims; n++) {
    // One shared draw per game, one idiosyncratic draw per team.
    const shared = rng.gammaMeanOne(environment);
    const lambdaHome = expected.home * shared * rng.gammaMeanOne(team);
    const lambdaAway = expected.away * shared * rng.gammaMeanOne(team);

    let home = rng.poisson(lambdaHome);
    let away = rng.poisson(lambdaAway);

    // --- Bottom of the ninth ------------------------------------------------
    // A home team that is already ahead does not bat. We sample the ninth they
    // would have had and remove it — but only if the lead survives without it.
    // If it does not, the lead was created in that inning, i.e. a walk-off, and
    // play stops the instant they go ahead.
    if (config.homeNinthTruncation && home > away) {
      const ninth = rng.poisson(lambdaHome / 9);
      const beforeNinth = home - ninth;
      home = beforeNinth > away ? beforeNinth : away + 1;
    }

    // --- Extra innings ------------------------------------------------------
    // Baseball does not end level (NPB draws aside, which we treat as decided
    // for pricing purposes). Resolving ties properly matters beyond the
    // moneyline: an extra-inning home win is almost always by exactly one run,
    // which is precisely the margin the −1.5 run line turns on.
    if (home === away) {
      extraInningGames++;
      const perHalfHome = (lambdaHome / 9) * config.extraInningBoost;
      const perHalfAway = (lambdaAway / 9) * config.extraInningBoost;

      let inning = 0;
      while (home === away && inning < config.maxExtraInnings) {
        inning++;
        away += rng.poisson(perHalfAway);
        const runsToWin = away - home + 1;
        home += Math.min(rng.poisson(perHalfHome), runsToWin);
      }

      if (home === away) {
        forcedResolutions++;
        if (rng.next() < 0.5) home++;
        else away++;
      }
    }

    sumHome += home;
    sumAway += away;
    sumHomeSq += home * home;
    sumAwaySq += away * away;
    sumProduct += home * away;

    if (home > config.maxRuns || away > config.maxRuns) {
      overflow++;
      if (home > config.maxRuns) home = config.maxRuns;
      if (away > config.maxRuns) away = config.maxRuns;
    }
    joint[home * stride + away]++;
  }

  const n = config.sims;
  const meanHome = sumHome / n;
  const meanAway = sumAway / n;
  const varHome = sumHomeSq / n - meanHome * meanHome;
  const varAway = sumAwaySq / n - meanAway * meanAway;
  const covariance = sumProduct / n - meanHome * meanAway;
  const denominator = Math.sqrt(varHome * varAway);

  return {
    sims: n,
    seed: config.seed,
    stride,
    joint,
    overflow,
    forcedResolutions,
    meanRuns: { home: meanHome, away: meanAway },
    varianceRuns: { home: varHome, away: varAway },
    runCorrelation: denominator > 0 ? covariance / denominator : 0,
    extraInningRate: extraInningGames / n,
    generatedAt: new Date().toISOString(),
    inputsHash: hashInputs(expected, config),
  };
}

/**
 * How many simulations are needed for a given margin of error on a probability.
 *
 * Worst case is a coin-flip market, where the standard error is `0.5/sqrt(n)`.
 * At 95% confidence, ±1% needs ~9,600 sims and ±0.5% needs ~38,400 — which is
 * the honest reason the plan's default of 10,000 is the floor, not a ceiling,
 * for chasing edges of a percent or two.
 */
export function simsForMarginOfError(marginOfError: number, confidenceZ = 1.96): number {
  if (!(marginOfError > 0)) throw new RangeError("marginOfError must be > 0");
  return Math.ceil((confidenceZ * confidenceZ * 0.25) / (marginOfError * marginOfError));
}
