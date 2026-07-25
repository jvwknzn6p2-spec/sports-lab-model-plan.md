/**
 * Self-checking test suite. Run with `pnpm --filter @workspace/sim run test`.
 *
 * Uses no test framework — Node 22 strips the types and runs this file
 * directly, so the simulation layer stays verifiable without adding a
 * dependency to a workspace that deliberately keeps its install surface small.
 *
 * The assertions are the interesting part. A Monte Carlo engine that compiles
 * is worth nothing; what matters is that the distribution it produces has the
 * mean, variance, correlation and tail behaviour it claims to have. Statistical
 * checks use tolerances wide enough not to flake but tight enough to catch a
 * real regression.
 */

import { Rng } from "./rng.ts";
import {
  expectedTotal,
  marginDistribution,
  priceHandicap,
  priceMoneyline,
  priceTotal,
  totalDistribution,
} from "./markets.ts";
import {
  americanToDecimal,
  assessValue,
  bookmakerMargin,
  decimalToAmerican,
  expectedValue,
  overround,
  removeVig,
  type DevigMethod,
} from "./odds.ts";
import { predictGame } from "./predict.ts";
import { simsForMarginOfError, simulateGame, solveDispersion } from "./simulate.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(name: string, actual: number, expected: number, tolerance: number): void {
  const delta = Math.abs(actual - expected);
  check(
    name,
    delta <= tolerance,
    `expected ${expected.toFixed(4)} ±${tolerance}, got ${actual.toFixed(4)}`,
  );
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number {
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) * (value - m), 0) / values.length;
}

// ---------------------------------------------------------------------------
section("RNG and distributions");
// ---------------------------------------------------------------------------
{
  const a = new Rng("seed-a");
  const b = new Rng("seed-a");
  const c = new Rng("seed-b");
  const drawA = Array.from({ length: 50 }, () => a.nextUint32());
  const drawB = Array.from({ length: 50 }, () => b.nextUint32());
  const drawC = Array.from({ length: 50 }, () => c.nextUint32());

  check("same seed reproduces the same stream", drawA.every((v, i) => v === drawB[i]));
  check("different seed diverges", drawA.some((v, i) => v !== drawC[i]));

  const rng = new Rng(1);
  const uniforms = Array.from({ length: 200_000 }, () => rng.next());
  near("uniform mean is 0.5", mean(uniforms), 0.5, 0.005);
  near("uniform variance is 1/12", variance(uniforms), 1 / 12, 0.005);
  check(
    "uniform stays in [0, 1)",
    uniforms.every((u) => u >= 0 && u < 1),
  );

  const normals = Array.from({ length: 200_000 }, () => rng.normal());
  near("normal mean is 0", mean(normals), 0, 0.02);
  near("normal variance is 1", variance(normals), 1, 0.02);

  for (const k of [0.5, 4.05, 40]) {
    const draws = Array.from({ length: 200_000 }, () => rng.gammaMeanOne(k));
    near(`gammaMeanOne(${k}) has mean 1`, mean(draws), 1, 0.02);
    near(`gammaMeanOne(${k}) has variance 1/k`, variance(draws), 1 / k, (1 / k) * 0.05);
  }

  check("gammaMeanOne(Infinity) is deterministic", rng.gammaMeanOne(Infinity) === 1);

  for (const lambda of [0.5, 4.5, 12]) {
    const draws = Array.from({ length: 200_000 }, () => rng.poisson(lambda));
    near(`poisson(${lambda}) has mean lambda`, mean(draws), lambda, lambda * 0.02);
    near(`poisson(${lambda}) has variance lambda`, variance(draws), lambda, lambda * 0.03);
  }
  check("poisson(0) is 0", rng.poisson(0) === 0);
}

// ---------------------------------------------------------------------------
section("Dispersion solver");
// ---------------------------------------------------------------------------
{
  const mu = { home: 4.6, away: 4.4 };
  const k = 4.05;
  const solved = solveDispersion(k, 0.05, mu);

  // Verify the identity the solver is built on: the two concentrations must
  // compose back to the requested total dispersion.
  const composed = (1 + 1 / solved.environment) * (1 + 1 / solved.team) - 1;
  near("environment and team dispersion compose to 1/k", composed, 1 / k, 1e-9);

  const varHome = mu.home + (mu.home * mu.home) / k;
  const varAway = mu.away + (mu.away * mu.away) / k;
  const impliedCorrelation =
    (mu.home * mu.away) / solved.environment / Math.sqrt(varHome * varAway);
  near("solver reproduces the requested correlation", impliedCorrelation, 0.05, 1e-9);

  const zero = solveDispersion(k, 0, mu);
  check("zero correlation removes the shared factor", zero.environment === Infinity);
  check("zero correlation puts all dispersion on the team", zero.team === k);

  const greedy = solveDispersion(k, 0.95, mu);
  check("unreachable correlation is clamped, not thrown", Number.isFinite(greedy.environment));
  check("clamped correlation stays below the requested value", greedy.correlationApplied < 0.95);

  let threw = false;
  try {
    solveDispersion(-1, 0.05, mu);
  } catch {
    threw = true;
  }
  check("negative dispersion is rejected", threw);
}

// ---------------------------------------------------------------------------
section("Run model calibration");
// ---------------------------------------------------------------------------
{
  // Truncation off so the raw negative-binomial shape is visible. Extra innings
  // remain on, which lifts the mean slightly above the input — that is correct
  // behaviour, not drift, so the tolerances allow for it.
  const dist = simulateGame(
    { home: 4.5, away: 4.5 },
    { seed: "calibration", sims: 200_000, homeNinthTruncation: false },
  );

  near("mean home runs tracks the input", dist.meanRuns.home, 4.5, 0.15);
  near("mean away runs tracks the input", dist.meanRuns.away, 4.5, 0.15);

  // Target: var = mu + mu^2/k = 4.5 + 20.25/4.05 = 9.5.
  near("run variance matches the negative binomial target", dist.varianceRuns.home, 9.5, 0.7);
  check(
    "variance clearly exceeds the mean (not Poisson)",
    dist.varianceRuns.home > dist.meanRuns.home * 1.6,
    `variance ${dist.varianceRuns.home.toFixed(2)} vs mean ${dist.meanRuns.home.toFixed(2)}`,
  );

  check(
    "scores are positively but weakly correlated",
    dist.runCorrelation > 0.02 && dist.runCorrelation < 0.15,
    `correlation ${dist.runCorrelation.toFixed(4)}`,
  );

  check(
    "extra-inning rate is realistic",
    dist.extraInningRate > 0.06 && dist.extraInningRate < 0.12,
    `${(dist.extraInningRate * 100).toFixed(2)}%`,
  );

  check("no simulations were clamped by maxRuns", dist.overflow === 0, `${dist.overflow} clamped`);
  // The coin-flip fallback is a safety valve, not a modelling choice, so what
  // matters is that it is statistically irrelevant rather than literally never
  // hit — a very low-scoring simulated game can genuinely stay level for
  // twenty extra innings. At the default cap this runs at a few parts per
  // million; a regression that broke the cap would blow past this bound.
  check(
    "the extra-innings safety valve is negligible",
    dist.forcedResolutions / dist.sims < 1e-4,
    `${dist.forcedResolutions} in ${dist.sims}`,
  );

  const uncorrelated = simulateGame(
    { home: 4.5, away: 4.5 },
    { seed: "calibration", sims: 200_000, environmentCorrelation: 0, homeNinthTruncation: false },
  );
  check(
    "zero-correlation config produces near-zero correlation",
    Math.abs(uncorrelated.runCorrelation) < 0.03,
    `correlation ${uncorrelated.runCorrelation.toFixed(4)}`,
  );
  check(
    "correlation is higher when requested",
    dist.runCorrelation > uncorrelated.runCorrelation,
  );
}

// ---------------------------------------------------------------------------
section("Ninth-inning truncation");
// ---------------------------------------------------------------------------
{
  const options = { seed: "truncation", sims: 100_000 } as const;
  const withTruncation = simulateGame({ home: 4.6, away: 4.4 }, { ...options });
  const without = simulateGame(
    { home: 4.6, away: 4.4 },
    { ...options, homeNinthTruncation: false },
  );

  check(
    "truncation lowers the expected total",
    expectedTotal(withTruncation) < expectedTotal(without),
    `${expectedTotal(withTruncation).toFixed(3)} vs ${expectedTotal(without).toFixed(3)}`,
  );

  const reduction = expectedTotal(without) - expectedTotal(withTruncation);
  check(
    "the reduction is material but not extreme",
    reduction > 0.05 && reduction < 0.6,
    `${reduction.toFixed(3)} runs`,
  );

  check(
    "truncation only affects the home team",
    Math.abs(withTruncation.meanRuns.away - without.meanRuns.away) < 0.05,
  );

  // The rule removes runs only from games the home team had already won, so it
  // must not move the moneyline at all.
  const withWin = priceMoneyline(withTruncation, "home").win;
  const withoutWin = priceMoneyline(without, "home").win;
  near("truncation is winner-preserving", withWin, withoutWin, 0.012);
}

// ---------------------------------------------------------------------------
section("Market pricing coherence");
// ---------------------------------------------------------------------------
{
  const dist = simulateGame({ home: 4.9, away: 4.0 }, { seed: "pricing", sims: 100_000 });

  const home = priceMoneyline(dist, "home");
  const away = priceMoneyline(dist, "away");
  near("moneyline probabilities sum to 1", home.win + away.win, 1, 1e-9);
  check("no ties on the moneyline", home.push === 0 && away.push === 0);
  check("the better team is favoured", home.win > away.win);
  near("fair decimal odds invert the probability", home.fairDecimal, 1 / home.win, 1e-9);

  for (const line of [-2, -1.5, -1, -0.5, 0, 0.5, 1.5, 2]) {
    const price = priceHandicap(dist, "home", line);
    near(`handicap ${line}: win + push + loss = 1`, price.win + price.push + price.loss, 1, 1e-9);
    const mirror = priceHandicap(dist, "away", -line);
    near(
      `handicap ${line}: the two sides are complementary`,
      price.win + mirror.win + price.push,
      1,
      1e-9,
    );
  }

  check(
    "integer handicaps can push, half handicaps cannot",
    priceHandicap(dist, "home", -1).push > 0 && priceHandicap(dist, "home", -1.5).push === 0,
  );

  check(
    "covering -1.5 is harder than winning outright",
    priceHandicap(dist, "home", -1.5).win < home.win,
  );
  check(
    "a bigger handicap is harder to cover",
    priceHandicap(dist, "home", -2.5).win < priceHandicap(dist, "home", -1.5).win,
  );

  for (const line of [7, 8.5, 9, 10.5]) {
    const over = priceTotal(dist, "over", line);
    const under = priceTotal(dist, "under", line);
    near(`total ${line}: over + under + push = 1`, over.win + under.win + over.push, 1, 1e-9);
    near(`total ${line}: push agrees on both sides`, over.push, under.push, 1e-9);
  }

  check(
    "a higher total is harder to go over",
    priceTotal(dist, "over", 10.5).win < priceTotal(dist, "over", 8.5).win,
  );

  // Quarter lines are two half-stakes; the blend must be exactly the average.
  const quarter = priceHandicap(dist, "home", -0.75);
  const lower = priceHandicap(dist, "home", -0.5);
  const upper = priceHandicap(dist, "home", -1);
  near("quarter handicap blends its two half-lines", quarter.win, (lower.win + upper.win) / 2, 1e-9);
  near("quarter handicap blends the push too", quarter.push, (lower.push + upper.push) / 2, 1e-9);

  const quarterTotal = priceTotal(dist, "over", 8.75);
  near(
    "quarter total blends its two half-lines",
    quarterTotal.win,
    (priceTotal(dist, "over", 8.5).win + priceTotal(dist, "over", 9).win) / 2,
    1e-9,
  );

  let threw = false;
  try {
    priceHandicap(dist, "home", -1.3);
  } catch {
    threw = true;
  }
  check("a line off the quarter-run grid is rejected", threw);

  const margins = marginDistribution(dist);
  near(
    "margin distribution sums to 1",
    margins.probabilities.reduce((s, p) => s + p, 0),
    1,
    1e-9,
  );
  check(
    "no game finishes level",
    margins.probabilities[-margins.offset] === 0,
    `P(margin = 0) = ${margins.probabilities[-margins.offset]}`,
  );

  near(
    "total distribution sums to 1",
    totalDistribution(dist).reduce((s, p) => s + p, 0),
    1,
    1e-9,
  );
}

// ---------------------------------------------------------------------------
section("Home/away asymmetry");
// ---------------------------------------------------------------------------
{
  const evenTeams = { home: 4.5, away: 4.5 } as const;
  const withRules = simulateGame(evenTeams, { seed: "symmetry", sims: 200_000 });
  const noTruncation = simulateGame(evenTeams, {
    seed: "symmetry",
    sims: 200_000,
    homeNinthTruncation: false,
  });

  // The run generator itself must be perfectly even-handed: with the
  // ninth-inning rule off, two identical teams should be statistically
  // indistinguishable.
  near(
    "the run generator is unbiased",
    noTruncation.meanRuns.home,
    noTruncation.meanRuns.away,
    0.05,
  );
  near(
    "run variance is unbiased",
    noTruncation.varianceRuns.home,
    noTruncation.varianceRuns.away,
    0.3,
  );
  near("evenly matched teams are a coin flip", priceMoneyline(withRules, "home").win, 0.5, 0.01);

  // Margins, however, are deliberately asymmetric — and this is the payoff for
  // modelling the ninth-inning rule and walk-offs rather than drawing two
  // independent scores. A home team stops batting the moment it leads, so its
  // wins bunch up at exactly one run and it covers a −1.5 line noticeably less
  // often than an identical away team would. A simulator that ignores this
  // prices the run line wrong in a consistent, exploitable direction.
  const margins = marginDistribution(withRules);
  const atMargin = (m: number): number => margins.probabilities[m - margins.offset];

  check(
    "one-run home wins are more common than one-run away wins",
    atMargin(1) > atMargin(-1) * 1.2,
    `+1 = ${(atMargin(1) * 100).toFixed(2)}%, -1 = ${(atMargin(-1) * 100).toFixed(2)}%`,
  );
  check(
    "the home team covers -1.5 less often than the away team",
    priceHandicap(withRules, "home", -1.5).win < priceHandicap(withRules, "away", -1.5).win,
  );

  const gapWithRule =
    priceHandicap(withRules, "away", -1.5).win - priceHandicap(withRules, "home", -1.5).win;
  const gapWithout =
    priceHandicap(noTruncation, "away", -1.5).win - priceHandicap(noTruncation, "home", -1.5).win;
  check(
    "the ninth-inning rule is what drives most of that gap",
    gapWithRule > gapWithout * 2,
    `${(gapWithRule * 100).toFixed(2)}pp with the rule, ${(gapWithout * 100).toFixed(2)}pp without`,
  );
  check(
    "walk-offs leave a residual gap even with the rule off",
    gapWithout > 0.005,
    `${(gapWithout * 100).toFixed(2)}pp`,
  );
}

// ---------------------------------------------------------------------------
section("Odds mathematics");
// ---------------------------------------------------------------------------
{
  near("+150 converts to 2.5", americanToDecimal(150), 2.5, 1e-12);
  near("-200 converts to 1.5", americanToDecimal(-200), 1.5, 1e-12);
  near("2.5 converts back to +150", decimalToAmerican(2.5), 150, 1e-9);
  near("1.5 converts back to -200", decimalToAmerican(1.5), -200, 1e-9);
  for (const american of [-450, -110, 125, 900]) {
    near(
      `american ${american} round-trips`,
      decimalToAmerican(americanToDecimal(american)),
      american,
      1e-9,
    );
  }
  check("unbeatable selections report +Infinity", decimalToAmerican(Infinity) === Infinity);

  near("1.91 / 1.91 has a 4.71% overround", overround([1.91, 1.91]) - 1, 0.0471, 0.0002);
  near("1.91 / 1.91 has a 4.50% hold", bookmakerMargin([1.91, 1.91]), 0.045, 0.0005);

  const methods: DevigMethod[] = ["multiplicative", "additive", "power", "shin"];
  for (const method of methods) {
    const fair = removeVig([1.91, 1.91], method);
    near(`${method}: fair probabilities sum to 1`, fair[0] + fair[1], 1, 1e-6);
    near(`${method}: a symmetric market de-vigs to 50/50`, fair[0], 0.5, 1e-6);

    const skewed = removeVig([1.25, 4.2], method);
    near(`${method}: skewed market sums to 1`, skewed[0] + skewed[1], 1, 1e-6);
    check(
      `${method}: the favourite stays the favourite`,
      skewed[0] > skewed[1],
      `${skewed[0].toFixed(4)} vs ${skewed[1].toFixed(4)}`,
    );
    check(
      `${method}: removing vig lowers the quoted probability`,
      skewed[0] < 1 / 1.25 && skewed[1] < 1 / 4.2,
    );
  }

  // The methods must disagree on a lopsided market — that disagreement is the
  // whole reason more than one is offered.
  const multiplicative = removeVig([1.25, 4.2], "multiplicative");
  const shin = removeVig([1.25, 4.2], "shin");
  check(
    "shin and multiplicative differ on a skewed market",
    Math.abs(multiplicative[1] - shin[1]) > 1e-4,
  );
  check(
    "shin shades the longshot down relative to multiplicative",
    shin[1] < multiplicative[1],
  );

  const balanced = removeVig([2.0, 2.0], "multiplicative");
  near("a vig-free market is left alone", balanced[0], 0.5, 1e-12);

  near("EV is zero at fair odds", expectedValue(0.5, 2.0), 0, 1e-12);
  near("EV is positive above fair odds", expectedValue(0.55, 2.0), 0.1, 1e-12);
  near("EV is negative below fair odds", expectedValue(0.45, 2.0), -0.1, 1e-12);
  near("a push refunds the stake", expectedValue(0.5, 2.0, 0.1), 0.1, 1e-12);
}

// ---------------------------------------------------------------------------
section("Value assessment against a real market");
// ---------------------------------------------------------------------------
{
  // A model that agrees exactly with the de-vigged market has no edge, even
  // though it beats neither quoted price. This is the check that separates a
  // real edge from the bookmaker's margin.
  const noEdge = assessValue(0.5, [1.91, 1.91], 0);
  near("agreeing with the market means zero edge", noEdge.edge, 0, 1e-9);
  check("but EV against the quoted price is still negative", noEdge.expectedValue < 0);
  check("no edge means no Kelly stake", noEdge.kelly === 0);

  const realEdge = assessValue(0.56, [1.91, 1.91], 0);
  near("a 6-point edge is reported as 0.06", realEdge.edge, 0.06, 1e-9);
  check("a 6-point edge clears the margin", realEdge.expectedValue > 0);
  check("Kelly is positive but sane", realEdge.kelly > 0 && realEdge.kelly < 0.2);
  near("fair odds reflect the model", realEdge.fairDecimal, 1 / 0.56, 1e-9);
  near("the market margin is reported", realEdge.margin, 0.045, 0.0005);

  // The stronger standard: does the edge survive a 10% hold? On a symmetric
  // market held at 10% both sides are quoted 1.80, so break-even needs a model
  // probability of 1/1.8 = 55.6% — an edge of 5.6 points over the fair 50%.
  // Anything smaller loses money no matter how good it looks against the
  // quoted price.
  const heavyHold = assessValue(0.56, [1.8, 1.8], 0);
  near("a 10% hold is detected", heavyHold.margin, 0.1, 0.001);
  near("edge is unchanged by the hold", heavyHold.edge, 0.06, 1e-9);
  check(
    "a 6-point edge clears a 10% hold, but only just",
    heavyHold.expectedValue > 0 && heavyHold.expectedValue < 0.02,
    `EV = ${(heavyHold.expectedValue * 100).toFixed(2)}%`,
  );

  const thinEdge = assessValue(0.53, [1.8, 1.8], 0);
  check(
    "a 3-point edge does not survive a 10% hold",
    thinEdge.edge > 0 && thinEdge.expectedValue < 0,
    `edge +${(thinEdge.edge * 100).toFixed(1)}pp but EV ${(thinEdge.expectedValue * 100).toFixed(2)}%`,
  );

  // The same 3-point edge is comfortably profitable at a sharp book's price.
  const sharpBook = assessValue(0.53, [1.97, 1.97], 0);
  check(
    "the same edge is profitable at a 1.5% hold",
    sharpBook.expectedValue > 0,
    `EV = ${(sharpBook.expectedValue * 100).toFixed(2)}%`,
  );
}

// ---------------------------------------------------------------------------
section("Simulation sizing");
// ---------------------------------------------------------------------------
{
  check("±1% needs about 9,600 sims", simsForMarginOfError(0.01) === 9604);
  check("±0.5% needs about 38,400 sims", simsForMarginOfError(0.005) === 38416);
  check(
    "tighter margins need more sims",
    simsForMarginOfError(0.005) > simsForMarginOfError(0.01),
  );

  const dist = simulateGame({ home: 4.5, away: 4.5 }, { seed: "sizing", sims: 10_000 });
  const price = priceMoneyline(dist, "home");
  near("standard error at 10k sims is about 0.5%", price.standardError, 0.005, 0.0005);
}

// ---------------------------------------------------------------------------
section("End-to-end prediction");
// ---------------------------------------------------------------------------
{
  const prediction = predictGame({
    expected: { home: 4.8, away: 4.1 },
    seed: "2026-07-25:LAA@HOU",
    totalLine: 8.5,
  });

  check("the home favourite is favoured", prediction.moneyline.home.win > 0.5);
  near(
    "moneyline is coherent",
    prediction.moneyline.home.win + prediction.moneyline.away.win,
    1,
    1e-9,
  );
  check("the run line is priced", prediction.runLine.line === 1.5);
  check("the total is priced", prediction.total !== null);
  near(
    "expected total matches the distribution",
    prediction.expectedRuns.total,
    prediction.expectedRuns.home + prediction.expectedRuns.away,
    1e-9,
  );
  check("likeliest scores are returned", prediction.likeliestScores.length === 5);
  check(
    "likeliest scores are sorted",
    prediction.likeliestScores.every(
      (score, i) => i === 0 || score.probability <= prediction.likeliestScores[i - 1].probability,
    ),
  );
  check("diagnostics report a Monte Carlo error", prediction.diagnostics.monteCarloError > 0);
  check("diagnostics carry a timestamp", prediction.diagnostics.generatedAt.endsWith("Z"));
  check("diagnostics carry an inputs hash", /^[0-9a-f]{8}$/.test(prediction.diagnostics.inputsHash));

  const repeat = predictGame({
    expected: { home: 4.8, away: 4.1 },
    seed: "2026-07-25:LAA@HOU",
    totalLine: 8.5,
  });
  check(
    "the same seed reproduces the same probabilities",
    repeat.moneyline.home.win === prediction.moneyline.home.win,
  );
  check("the same inputs hash to the same value", repeat.diagnostics.inputsHash === prediction.diagnostics.inputsHash);

  const different = predictGame({
    expected: { home: 4.8, away: 4.1 },
    seed: "different-seed",
    totalLine: 8.5,
  });
  check(
    "a different seed gives a different answer",
    different.moneyline.home.win !== prediction.moneyline.home.win,
  );
  check(
    "but the two agree within Monte Carlo error",
    Math.abs(different.moneyline.home.win - prediction.moneyline.home.win) <
      4 * prediction.diagnostics.monteCarloError,
  );

  // A shutout-level pitching matchup should still be simulated sanely.
  const lowScoring = predictGame({
    expected: { home: 2.1, away: 1.9 },
    seed: "low-scoring",
    totalLine: 4.5,
  });
  check("a low-scoring game stays coherent", lowScoring.expectedRuns.total < 4.6);
  check("no overflow in a low-scoring game", lowScoring.diagnostics.overflow === 0);

  let threw = false;
  try {
    predictGame({ expected: { home: -1, away: 4 }, seed: "invalid" });
  } catch {
    threw = true;
  }
  check("negative expected runs are rejected", threw);
}

// ---------------------------------------------------------------------------
console.log(`\n${"-".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("All checks passed.");
