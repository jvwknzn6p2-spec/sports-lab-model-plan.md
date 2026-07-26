import { test } from "node:test";
import assert from "node:assert/strict";
import { BaselineInputError, computeBaseline, explainEstimate } from "./baseline";
import { HOME_FIELD_ADVANTAGE, LEAGUE_RUNS_PER_GAME } from "./constants";
import { neutralGame, validGame } from "../test-fixtures";

/** Find a named step in an estimate's trace. */
function step(steps: ReturnType<typeof computeBaseline>["home"]["steps"], label: string) {
  const found = steps.find((s) => s.label === label);
  assert.ok(found, `expected a "${label}" step`);
  return found!;
}

test("a fully neutral game returns the league baseline, plus home-field edge", () => {
  const { game, context } = neutralGame();
  const r = computeBaseline(game, context);

  // Away team: every multiplier is 1.0 → exactly the league baseline.
  assert.equal(r.away.expectedRuns, LEAGUE_RUNS_PER_GAME);
  // Home team: identical except home-field advantage.
  assert.ok(Math.abs(r.home.expectedRuns - LEAGUE_RUNS_PER_GAME * HOME_FIELD_ADVANTAGE) < 1e-9);
  assert.ok(r.expectedMargin > 0, "home should be favored on home-field advantage alone");
});

test("total and margin are consistent with the two sides", () => {
  const { game, context } = neutralGame();
  const r = computeBaseline(game, context);
  assert.ok(Math.abs(r.expectedTotal - (r.home.expectedRuns + r.away.expectedRuns)) < 1e-9);
  assert.ok(Math.abs(r.expectedMargin - (r.home.expectedRuns - r.away.expectedRuns)) < 1e-9);
});

test("a better offense raises that team's expected runs", () => {
  const { game, context } = neutralGame();
  const before = computeBaseline(game, context).away.expectedRuns;
  game.awayBatting!.runsPerGame = 5.4; // a run per game above league average
  const after = computeBaseline(game, context).away.expectedRuns;
  assert.ok(after > before, "stronger offense should score more");
  // Shrinkage means the full +1.0 r/g does not pass through untouched.
  assert.ok(after - before < 1.0, "offense should be shrunk toward league average");
});

test("a tougher opposing starter lowers expected runs", () => {
  const { game, context } = neutralGame();
  const before = computeBaseline(game, context).home.expectedRuns;
  game.awayStarter!.seasonEra = 2.5; // ace facing the home team
  const after = computeBaseline(game, context).home.expectedRuns;
  assert.ok(after < before);
  assert.ok(step(computeBaseline(game, context).home.steps, "Opposing starter").multiplier < 1);
});

test("a tired opposing bullpen raises expected runs", () => {
  const { game, context } = neutralGame();
  const before = computeBaseline(game, context).home.expectedRuns;
  game.awayBullpen!.inningsPitchedLast3Days = 14; // well over the threshold
  const r = computeBaseline(game, context);
  assert.ok(r.home.expectedRuns > before);
  assert.ok(step(r.home.steps, "Opposing bullpen fatigue").multiplier > 1);
});

test("key hitters ruled out reduce that team's offense, capped", () => {
  const { game, context } = neutralGame();
  const before = computeBaseline(game, context).away.expectedRuns;
  context.injuries.away.injuries = [
    { playerId: "a", name: "A", status: "out", impact: "key-hitter", note: null },
    { playerId: "b", name: "B", status: "out", impact: "key-hitter", note: null },
    { playerId: "c", name: "C", status: "out", impact: "key-hitter", note: null },
    { playerId: "d", name: "D", status: "out", impact: "key-hitter", note: null },
    { playerId: "e", name: "E", status: "out", impact: "key-hitter", note: null },
  ];
  const r = computeBaseline(game, context);
  assert.ok(r.away.expectedRuns < before);
  // 5 hitters × 3% = 15%, capped at 9%.
  assert.ok(Math.abs(step(r.away.steps, "Injuries").multiplier - 0.91) < 1e-9);
});

test("day-to-day and bench injuries do not move the offense", () => {
  const { game, context } = neutralGame();
  const before = computeBaseline(game, context).away.expectedRuns;
  context.injuries.away.injuries = [
    { playerId: "a", name: "A", status: "day-to-day", impact: "key-hitter", note: null },
    { playerId: "b", name: "B", status: "out", impact: "bench", note: null },
  ];
  assert.equal(computeBaseline(game, context).away.expectedRuns, before);
});

test("a hitter's park raises both teams' expected runs", () => {
  const { game, context } = neutralGame();
  const before = computeBaseline(game, context);
  context.ballpark = {
    venueId: "v-col",
    runsFactor: 1.15,
    hrFactor: 1.11,
    isNeutralFallback: false,
  };
  const after = computeBaseline(game, context);
  assert.ok(after.home.expectedRuns > before.home.expectedRuns);
  assert.ok(after.away.expectedRuns > before.away.expectedRuns);
});

test("neutral-fallback park factors are skipped, not applied", () => {
  const { game, context } = neutralGame();
  context.ballpark.isNeutralFallback = true;
  const r = computeBaseline(game, context);
  assert.equal(step(r.home.steps, "Ballpark").applied, false);
  assert.equal(r.away.expectedRuns, 4.4);
});

test("wind blowing out raises runs; wind blowing in lowers them", () => {
  const { game, context } = neutralGame();
  context.weather.windSpeedMph = 15;

  context.weather.windRelative = "out";
  const out = computeBaseline(game, context).away.expectedRuns;
  context.weather.windRelative = "in";
  const inward = computeBaseline(game, context).away.expectedRuns;
  context.weather.windRelative = "cross";
  const cross = computeBaseline(game, context).away.expectedRuns;

  assert.ok(out > cross, "wind out should add runs");
  assert.ok(inward < cross, "wind in should suppress runs");
});

test("a forecast moves the estimate less than the same observed reading", () => {
  const { game, context } = neutralGame();
  context.weather.temperatureF = 95;
  context.weather.windSpeedMph = 15;
  context.weather.windRelative = "out";

  context.weather.weatherMode = "observed";
  const observed = computeBaseline(game, context);

  context.weather.weatherMode = "forecast";
  context.weather.forecastFor = game.startTime;
  const forecast = computeBaseline(game, context);

  const observedLift = observed.away.expectedRuns - 4.4;
  const forecastLift = forecast.away.expectedRuns - 4.4;

  assert.ok(observedLift > 0 && forecastLift > 0, "hot + wind out should add runs either way");
  assert.ok(forecastLift < observedLift, "a forecast must be damped relative to an observation");
  assert.equal(forecast.weatherMode, "forecast");
  assert.equal(observed.weatherMode, "observed");
});

test("a closed roof neutralizes weather entirely", () => {
  const { game, context } = neutralGame();
  context.weather.roofState = "closed";
  context.weather.temperatureF = 95; // would otherwise add runs
  context.weather.windSpeedMph = 15;
  context.weather.windRelative = "out";
  const r = computeBaseline(game, context);
  assert.equal(r.weatherApplied, false);
  assert.equal(step(r.away.steps, "Weather").applied, false);
  assert.equal(r.away.expectedRuns, 4.4);
});

test("recent form is weighted down by a thin sample", () => {
  const { game, context } = neutralGame();
  context.recentForm.away.runsScoredPerGame = 6.6; // hot streak

  context.recentForm.away.sampleSize = 10; // full window
  const full = computeBaseline(game, context).away.expectedRuns;

  context.recentForm.away.sampleSize = 2; // thin sample
  const thin = computeBaseline(game, context).away.expectedRuns;

  assert.ok(full > thin, "a full-window hot streak should move the number more than a 2-game one");
});

test("missing optional inputs are skipped and recorded, not invented", () => {
  const { game, context } = neutralGame();
  game.awayStarter = null;
  game.awayBullpen = null;
  context.recentForm.home.sampleSize = 0;

  const r = computeBaseline(game, context);
  assert.equal(step(r.home.steps, "Opposing starter").applied, false);
  assert.equal(step(r.home.steps, "Opposing bullpen").applied, false);
  assert.equal(step(r.home.steps, "Recent form").applied, false);
  // Skipped steps leave the running total untouched.
  assert.ok(Math.abs(r.home.expectedRuns - 4.4 * 1.02) < 1e-9);
});

test("missing batting raises BaselineInputError listing every missing anchor", () => {
  const { game, context } = validGame();
  game.homeBatting = null;
  game.awayBatting!.runsPerGame = null;

  assert.throws(
    () => computeBaseline(game, context),
    (err: unknown) => {
      assert.ok(err instanceof BaselineInputError);
      assert.deepEqual(err.missing, ["homeBatting.runsPerGame", "awayBatting.runsPerGame"]);
      return true;
    },
  );
});

test("every step records a consistent before → after transition", () => {
  const { game, context } = validGame();
  const r = computeBaseline(game, context);
  for (const est of [r.home, r.away]) {
    for (const s of est.steps) {
      assert.ok(Math.abs(s.runsBefore * s.multiplier - s.runsAfter) < 0.01, `${s.label} is inconsistent`);
    }
    // The last step's runsAfter should match the reported expected runs.
    const last = est.steps[est.steps.length - 1];
    assert.ok(Math.abs(last.runsAfter - est.expectedRuns) < 0.01);
  }
});

test("step notes stay readable when a stat comes from division", () => {
  // A real feed derives runs/game by dividing totals, so the raw value has
  // full float precision. That belongs in the maths, never in the prose.
  const { game, context } = neutralGame();
  game.homeBatting!.runsPerGame = 490 / 101; // 4.851485148514851…
  const r = computeBaseline(game, context);
  const note = step(r.home.steps, "Team offense").note;

  assert.match(note, /scores 4\.85 r\/g/);
  assert.ok(!/\d\.\d{4,}/.test(note), `note should not carry raw precision: ${note}`);
  // The multiplier itself must still be computed from the unrounded value.
  assert.ok(Math.abs(step(r.home.steps, "Team offense").multiplier - 1) > 0.05);
});

test("explainEstimate renders one line per step plus a header", () => {
  const { game, context } = validGame();
  const r = computeBaseline(game, context);
  const lines = explainEstimate(r.home);
  assert.equal(lines.length, r.home.steps.length + 1);
  assert.match(lines[0], /home expected runs/);
  assert.ok(lines.some((l) => l.includes("Team offense")));
});
