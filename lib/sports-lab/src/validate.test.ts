import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGame } from "./validate";
import { REF_NOW, REF_FIRST_PITCH, validGame } from "./test-fixtures";

const opts = { asOf: REF_NOW };

test("clean data yields no flags and an S cap", () => {
  const { game, context } = validGame();
  const r = validateGame(game, context, opts);
  assert.equal(r.flags.length, 0);
  assert.equal(r.confidenceCap, "S");
  assert.equal(r.completeness, 1);
  assert.equal(r.hasErrors, false);
});

test("missing starter is an error and caps to C", () => {
  const { game, context } = validGame();
  game.awayStarter = null;
  const r = validateGame(game, context, opts);
  assert.equal(r.hasErrors, true);
  assert.equal(r.confidenceCap, "C");
  assert.ok(r.flags.some((f) => f.code === "missing_starter"));
  assert.ok(r.completeness < 1);
});

test("unconfirmed starter warns and caps to A", () => {
  const { game, context } = validGame();
  game.homeStarter!.confirmed = false;
  const r = validateGame(game, context, opts);
  assert.equal(r.confidenceCap, "A");
  assert.ok(r.flags.some((f) => f.code === "unconfirmed_starter"));
});

test("forecast weather is surfaced as info without capping on its own", () => {
  const { game, context } = validGame();
  context.weather.weatherMode = "forecast";
  context.weather.forecastFor = REF_FIRST_PITCH; // on-time forecast
  const r = validateGame(game, context, opts);
  const f = r.flags.find((x) => x.code === "weather_forecast");
  assert.ok(f, "expected weather_forecast flag");
  assert.equal(f!.severity, "info");
  assert.equal(r.confidenceCap, "S"); // an on-time forecast alone does not cap
});

test("stale forecast (wrong hour) warns and caps to A", () => {
  const { game, context } = validGame();
  context.weather.weatherMode = "forecast";
  context.weather.forecastFor = "2026-07-25T12:00:00Z"; // ~11h before first pitch
  const r = validateGame(game, context, opts);
  assert.ok(r.flags.some((f) => f.code === "weather_forecast_stale"));
  assert.equal(r.confidenceCap, "A");
});

test("closed roof suppresses all weather flags", () => {
  const { game, context } = validGame();
  context.weather.roofState = "closed";
  context.weather.temperatureF = null;
  context.weather.windSpeedMph = null;
  context.weather.precipitationChance = null;
  const r = validateGame(game, context, opts);
  assert.ok(!r.flags.some((f) => f.field.startsWith("weather")));
  assert.equal(r.confidenceCap, "S");
});

test("missing weather (open air) warns and caps to B", () => {
  const { game, context } = validGame();
  context.weather.temperatureF = null;
  context.weather.windSpeedMph = null;
  context.weather.precipitationChance = null;
  const r = validateGame(game, context, opts);
  assert.ok(r.flags.some((f) => f.code === "weather_missing"));
  assert.equal(r.confidenceCap, "B");
});

test("precip risk warns and caps to A", () => {
  const { game, context } = validGame();
  context.weather.precipitationChance = 0.6;
  const r = validateGame(game, context, opts);
  assert.ok(r.flags.some((f) => f.code === "weather_precip_risk"));
  assert.equal(r.confidenceCap, "A");
});

test("neutral-fallback park factors warn and cap to A", () => {
  const { game, context } = validGame();
  context.ballpark.isNeutralFallback = true;
  const r = validateGame(game, context, opts);
  assert.ok(r.flags.some((f) => f.code === "park_factors_fallback"));
  assert.equal(r.confidenceCap, "A");
});

test("unconfirmed lineup warns; key player out is info signal", () => {
  const { game, context } = validGame();
  context.injuries.home.lineupConfirmed = false;
  context.injuries.away.injuries = [
    { playerId: "x", name: "Mike Trout", status: "out", impact: "key-hitter", note: null },
  ];
  const r = validateGame(game, context, opts);
  assert.ok(r.flags.some((f) => f.code === "lineup_unconfirmed"));
  const injuryFlag = r.flags.find((f) => f.code === "injury_key_player_out");
  assert.ok(injuryFlag);
  assert.equal(injuryFlag!.severity, "info");
  assert.equal(r.confidenceCap, "A"); // from unconfirmed lineup, not the injury
});

test("missing recent form warns and caps to B", () => {
  const { game, context } = validGame();
  context.recentForm.away.sampleSize = 0;
  const r = validateGame(game, context, opts);
  assert.ok(r.flags.some((f) => f.code === "recent_form_missing"));
  assert.equal(r.confidenceCap, "B");
});

test("thin recent-form sample is info only", () => {
  const { game, context } = validGame();
  context.recentForm.home.sampleSize = 3;
  const r = validateGame(game, context, opts);
  const f = r.flags.find((x) => x.code === "recent_form_small_sample");
  assert.ok(f);
  assert.equal(f!.severity, "info");
  assert.equal(r.confidenceCap, "S");
});

test("stale source (fetched >24h ago) warns and caps to A", () => {
  const { game, context } = validGame();
  context.weather.fetchedAt = "2026-07-23T10:00:00Z"; // >24h before asOf
  const r = validateGame(game, context, opts);
  assert.ok(r.flags.some((f) => f.code === "stale_data"));
  assert.equal(r.confidenceCap, "A");
});

test("flags are ordered most-severe first", () => {
  const { game, context } = validGame();
  game.awayStarter = null; // error
  context.ballpark.isNeutralFallback = true; // warn
  context.recentForm.home.sampleSize = 2; // info
  const r = validateGame(game, context, opts);
  assert.equal(r.flags[0].severity, "error");
  assert.equal(r.flags[r.flags.length - 1].severity, "info");
});
