import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBaseline } from "./baseline";
import { explainSimulation, simulateGame, type SimulationResult } from "./simulate";
import { neutralGame } from "../test-fixtures";

/** Build a baseline result for a game, optionally skewing the two offenses. */
function baselineFor(homeRunsPerGame?: number, awayRunsPerGame?: number) {
  const { game, context } = neutralGame();
  if (homeRunsPerGame !== undefined) game.homeBatting!.runsPerGame = homeRunsPerGame;
  if (awayRunsPerGame !== undefined) game.awayBatting!.runsPerGame = awayRunsPerGame;
  return computeBaseline(game, context);
}

/** Iterations kept modest where the assertion does not need full resolution. */
const FAST = 4000;

test("the same seed reproduces the same probabilities exactly", () => {
  const b = baselineFor();
  const a = simulateGame(b, { iterations: FAST, seed: 123 });
  const c = simulateGame(b, { iterations: FAST, seed: 123 });
  assert.deepEqual(a, c);
});

test("a different seed gives a different but nearby answer", () => {
  const b = baselineFor();
  const a = simulateGame(b, { iterations: FAST, seed: 1 });
  const c = simulateGame(b, { iterations: FAST, seed: 2 });
  assert.notEqual(a.moneyline.home, c.moneyline.home);
  // Same underlying game, so they should still broadly agree.
  assert.ok(Math.abs(a.moneyline.home - c.moneyline.home) < 0.05);
});

test("moneyline probabilities sum to 1", () => {
  const r = simulateGame(baselineFor(), { iterations: FAST });
  assert.ok(Math.abs(r.moneyline.home + r.moneyline.away - 1) < 1e-9);
});

test("each run-line market's sides and push sum to 1", () => {
  const r = simulateGame(baselineFor(), { iterations: FAST });
  const rl = r.runLine;
  assert.ok(Math.abs(rl.homeCoversMinus + rl.awayCoversPlus + rl.homeSidePush - 1) < 1e-9);
  assert.ok(Math.abs(rl.awayCoversMinus + rl.homeCoversPlus + rl.awaySidePush - 1) < 1e-9);
});

test("the standard 1.5 run line can never push", () => {
  const r = simulateGame(baselineFor(), { iterations: FAST });
  assert.equal(r.runLine.homeSidePush, 0);
  assert.equal(r.runLine.awaySidePush, 0);
});

test("a whole-number run line pushes instead of crediting the underdog", () => {
  const r = simulateGame(baselineFor(), { iterations: 20_000, runLine: 1 });
  // A 1-run margin is common, so a 1.0 line should push often.
  assert.ok(r.runLine.homeSidePush > 0.1, `push rate was ${r.runLine.homeSidePush}`);
  assert.ok(r.runLine.awaySidePush > 0.1);
  assert.ok(
    Math.abs(r.runLine.homeCoversMinus + r.runLine.awayCoversPlus + r.runLine.homeSidePush - 1) <
      1e-9,
  );
});

test("an evenly matched game is near a coin flip, with a slight home edge", () => {
  const r = simulateGame(baselineFor(), { iterations: 20_000 });
  // neutralGame differs only by home-field advantage.
  assert.ok(r.moneyline.home > 0.5, "home should be favored");
  assert.ok(r.moneyline.home < 0.56, `home win % was ${r.moneyline.home}, expected near a coin flip`);
});

test("a much stronger home offense wins more often", () => {
  const even = simulateGame(baselineFor(), { iterations: 20_000 }).moneyline.home;
  const strong = simulateGame(baselineFor(6.5, 3.5), { iterations: 20_000 }).moneyline.home;
  assert.ok(strong > even + 0.1, `expected a clear jump, got ${even} → ${strong}`);
  assert.ok(strong < 1, "never certain — baseball is noisy");
});

test("even a heavy favorite loses a meaningful share of the time", () => {
  const r = simulateGame(baselineFor(7.0, 3.0), { iterations: 20_000 });
  // The plan's core caveat: strong picks still lose often.
  assert.ok(r.moneyline.away > 0.1, `underdog win % was ${r.moneyline.away}, implausibly low`);
});

test("covering the run line is harder than winning outright", () => {
  const r = simulateGame(baselineFor(5.5, 4.0), { iterations: 20_000 });
  assert.ok(
    r.runLine.homeCoversMinus < r.moneyline.home,
    "winning by 2+ must be rarer than simply winning",
  );
});

test("mean simulated runs track the baseline expectation", () => {
  const b = baselineFor(5.2, 4.0);
  const r = simulateGame(b, { iterations: 20_000 });
  // Extra innings add a little, so simulated means run slightly high.
  assert.ok(r.meanRuns.home >= b.home.expectedRuns - 0.1);
  assert.ok(r.meanRuns.home < b.home.expectedRuns + 0.4);
  assert.ok(r.meanRuns.away >= b.away.expectedRuns - 0.1);
  assert.ok(r.meanRuns.away < b.away.expectedRuns + 0.4);
});

test("over/under split around the posted line and sum to 1 with pushes", () => {
  const r = simulateGame(baselineFor(), { iterations: 20_000, totalLine: 8.5 });
  assert.ok(r.total.over !== null && r.total.under !== null && r.total.push !== null);
  assert.ok(Math.abs(r.total.over! + r.total.under! + r.total.push! - 1) < 1e-9);
  // A half-run line cannot be landed on exactly.
  assert.equal(r.total.push, 0);
});

test("a whole-number total line can push", () => {
  const r = simulateGame(baselineFor(), { iterations: 20_000, totalLine: 9 });
  assert.ok(r.total.push! > 0, "a 9.0 line should sometimes land exactly");
  assert.ok(Math.abs(r.total.over! + r.total.under! + r.total.push! - 1) < 1e-9);
});

test("a lower total line is easier to go over", () => {
  const b = baselineFor();
  const low = simulateGame(b, { iterations: 20_000, totalLine: 7.5 }).total.over!;
  const high = simulateGame(b, { iterations: 20_000, totalLine: 10.5 }).total.over!;
  assert.ok(low > high, `over% should fall as the line rises: ${low} vs ${high}`);
});

test("omitting the total line leaves over/under null but still reports the mean", () => {
  const r = simulateGame(baselineFor(), { iterations: FAST });
  assert.equal(r.total.line, null);
  assert.equal(r.total.over, null);
  assert.equal(r.total.under, null);
  assert.ok(r.total.mean > 0);
});

test("no simulated game ends in a tie", () => {
  // extraInningsRate counts ties that had to be resolved; the margin median
  // and win probabilities must nonetheless account for every iteration.
  const r = simulateGame(baselineFor(), { iterations: 20_000 });
  assert.ok(r.extraInningsRate > 0.02, "ties after 9 should happen sometimes");
  assert.ok(r.extraInningsRate < 0.25, `extra-innings rate ${r.extraInningsRate} is implausible`);
  assert.ok(Math.abs(r.moneyline.home + r.moneyline.away - 1) < 1e-9);
});

test("totals are overdispersed enough to be realistic", () => {
  const r = simulateGame(baselineFor(), { iterations: 20_000, totalLine: 8.5 });
  // With ~8.8 expected runs, neither side of a near-the-mean line should be
  // anywhere close to certain.
  assert.ok(r.total.over! > 0.3 && r.total.over! < 0.7, `over% was ${r.total.over}`);
});

test("iterations must be a positive integer", () => {
  const b = baselineFor();
  assert.throws(() => simulateGame(b, { iterations: 0 }), RangeError);
  assert.throws(() => simulateGame(b, { iterations: -5 }), RangeError);
  assert.throws(() => simulateGame(b, { iterations: 1.5 }), RangeError);
});

test("the result records the seed and iteration count for reproducibility", () => {
  const r = simulateGame(baselineFor(), { iterations: 1234, seed: 999 });
  assert.equal(r.iterations, 1234);
  assert.equal(r.seed, 999);
  assert.equal(r.gameId, "g-1");
});

test("explainSimulation renders the prediction-card lines", () => {
  const r: SimulationResult = simulateGame(baselineFor(5.2, 4.2), {
    iterations: FAST,
    totalLine: 8.5,
  });
  const lines = explainSimulation(r, { home: "Astros", away: "Angels" });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Moneyline:.*Astros.*Angels/);
  assert.match(lines[1], /Run line:.*1\.5/);
  assert.match(lines[2], /Total:.*Line 8\.5.*OVER/);
});
