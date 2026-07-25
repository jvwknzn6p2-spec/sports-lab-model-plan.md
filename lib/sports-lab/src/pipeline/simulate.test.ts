import assert from "node:assert/strict";
import test from "node:test";
import { MLB_CONSTANTS } from "../config";
import type { BaselineResult } from "../core/types";
import {
  defaultSimulationParams,
  probAbove,
  probBelow,
  probEqual,
  simulateGame,
} from "./simulate";

function baseline(homeRuns: number, awayRuns: number): BaselineResult {
  const team = (expectedRuns: number) => ({
    expectedRuns,
    leagueBaseline: MLB_CONSTANTS.leagueRunsPerGame,
    adjustments: [],
    opposingStarterInningsShare: 0.6,
  });
  return {
    teams: { home: team(homeRuns), away: team(awayRuns) },
    expectedTotal: homeRuns + awayRuns,
    expectedMargin: homeRuns - awayRuns,
  };
}

test("the same seed reproduces the simulation exactly", () => {
  const params = defaultSimulationParams({ simulations: 5000, seed: "fixed" });
  const first = simulateGame(baseline(4.8, 4.1), params);
  const second = simulateGame(baseline(4.8, 4.1), params);
  assert.equal(first.winProbability.home, second.winProbability.home);
  assert.equal(first.meanTotal, second.meanTotal);
  assert.deepEqual(first.marginHistogram, second.marginHistogram);
});

test("the better team wins more often, and probabilities sum to 1", () => {
  const result = simulateGame(
    baseline(5.4, 3.6),
    defaultSimulationParams({ simulations: 20000, seed: "mismatch" }),
  );
  assert.ok(result.winProbability.home > 0.6, `home win prob ${result.winProbability.home}`);
  assert.ok(result.winProbability.home < 0.85, "a 1.8 run edge is not a lock");
  assert.ok(
    Math.abs(result.winProbability.home + result.winProbability.away - 1) < 1e-12,
    "win probabilities must sum to 1",
  );
});

test("an even matchup lands near a coin flip, with the home side barely ahead", () => {
  const result = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({ simulations: 40000, seed: "even" }),
  );
  assert.ok(
    Math.abs(result.winProbability.home - 0.5) < 0.02,
    `equal expected runs should be ~50/50, got ${result.winProbability.home}`,
  );
});

test("mean simulated total tracks the baseline expectation", () => {
  const result = simulateGame(
    baseline(4.6, 4.2),
    defaultSimulationParams({ simulations: 40000, seed: "total" }),
  );
  // Extra innings add runs, so the simulated mean sits slightly above the sum.
  assert.ok(result.meanTotal > 8.8, `got ${result.meanTotal}`);
  assert.ok(result.meanTotal < 9.4, `got ${result.meanTotal}`);
});

test("without the correction, independent draws overstate extra innings", () => {
  const raw = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({
      simulations: 60000,
      seed: "extras-raw",
      targetExtraInningsRate: null,
    }),
  );
  // This is the documented bias: ~10% rather than the real ~8.7%.
  assert.ok(
    raw.extraInningsRate > 0.09,
    `expected the known overstatement, got ${raw.extraInningsRate}`,
  );
});

test("the extra-innings correction hits the calibrated target", () => {
  const corrected = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({
      simulations: 60000,
      seed: "extras-corrected",
      targetExtraInningsRate: 0.087,
    }),
  );
  assert.ok(
    Math.abs(corrected.extraInningsRate - 0.087) < 0.006,
    `corrected rate ${corrected.extraInningsRate} should be near 0.087`,
  );
});

test("the correction leaves the win probability essentially unchanged", () => {
  const shared = { simulations: 60000, seed: "neutrality" } as const;
  const raw = simulateGame(
    baseline(4.7, 4.2),
    defaultSimulationParams({ ...shared, targetExtraInningsRate: null }),
  );
  const corrected = simulateGame(
    baseline(4.7, 4.2),
    defaultSimulationParams({ ...shared, targetExtraInningsRate: 0.087 }),
  );
  assert.ok(
    Math.abs(raw.winProbability.home - corrected.winProbability.home) < 0.01,
    `win prob moved from ${raw.winProbability.home} to ${corrected.winProbability.home}`,
  );
});

test("no simulated game ends in a tie", () => {
  const result = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({ simulations: 20000, seed: "no-ties", targetExtraInningsRate: 0.087 }),
  );
  assert.equal(probEqual(result.marginHistogram, 0), 0);
});

test("histograms are consistent with the reported probabilities", () => {
  const result = simulateGame(
    baseline(4.9, 4.0),
    defaultSimulationParams({ simulations: 20000, seed: "hist", totalLine: 8.5 }),
  );
  assert.equal(result.marginHistogram.total, result.simulations);
  assert.equal(result.totalHistogram.total, result.simulations);

  // P(margin > 0) is the home win probability by definition.
  assert.ok(Math.abs(probAbove(result.marginHistogram, 0) - result.winProbability.home) < 1e-12);
  // P(margin > 1.5) is the -1.5 run-line cover.
  assert.ok(
    Math.abs(probAbove(result.marginHistogram, 1.5) - result.homeCoversMinus1p5) < 1e-12,
  );
  // Over + under + push must account for everything.
  const line = result.totalDistribution.line;
  const sum =
    probAbove(result.totalHistogram, line) +
    probBelow(result.totalHistogram, line) +
    probEqual(result.totalHistogram, line);
  assert.ok(Math.abs(sum - 1) < 1e-12, `distribution sums to ${sum}`);
});

test("a half-run line can never push", () => {
  const result = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({ simulations: 5000, seed: "push", totalLine: 8.5 }),
  );
  assert.equal(result.totalDistribution.push, 0);
});

test("an integer total line produces a real push probability", () => {
  const result = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({ simulations: 20000, seed: "push-int", totalLine: 9 }),
  );
  assert.ok(result.totalDistribution.push > 0.05, `got ${result.totalDistribution.push}`);
});

test("higher dispersion widens the run distribution", () => {
  const tight = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({ simulations: 30000, seed: "k", dispersionK: 50 }),
  );
  const loose = simulateGame(
    baseline(4.4, 4.4),
    defaultSimulationParams({ simulations: 30000, seed: "k", dispersionK: 2 }),
  );
  const tightSpread =
    (tight.percentiles.total["p90"] as number) - (tight.percentiles.total["p10"] as number);
  const looseSpread =
    (loose.percentiles.total["p90"] as number) - (loose.percentiles.total["p10"] as number);
  assert.ok(looseSpread > tightSpread, `${looseSpread} should exceed ${tightSpread}`);
});
