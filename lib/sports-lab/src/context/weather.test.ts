import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveWindRelative, isForecastStale, roofNeutralizesWeather } from "./weather";

// Park with center field due north (0°).
const CF_NORTH = 0;

test("wind from the south blows out toward north-facing CF", () => {
  assert.equal(deriveWindRelative(180, 12, CF_NORTH), "out");
});

test("wind from the north blows in from CF", () => {
  assert.equal(deriveWindRelative(0, 12, CF_NORTH), "in");
});

test("wind from the east is a crosswind", () => {
  assert.equal(deriveWindRelative(90, 12, CF_NORTH), "cross");
});

test("light wind is treated as calm regardless of bearing", () => {
  assert.equal(deriveWindRelative(180, 2, CF_NORTH), "calm");
});

test("handles wraparound near 360°", () => {
  // CF at 350°, wind from 170° blows toward 350° → out.
  assert.equal(deriveWindRelative(170, 10, 350), "out");
});

test("observed weather is never stale", () => {
  assert.equal(
    isForecastStale({ weatherMode: "observed", forecastFor: null }, "2026-07-25T23:10:00Z"),
    false,
  );
});

test("forecast within tolerance is not stale", () => {
  assert.equal(
    isForecastStale(
      { weatherMode: "forecast", forecastFor: "2026-07-25T22:00:00Z" },
      "2026-07-25T23:10:00Z",
      3,
    ),
    false,
  );
});

test("forecast far from first pitch is stale", () => {
  assert.equal(
    isForecastStale(
      { weatherMode: "forecast", forecastFor: "2026-07-25T12:00:00Z" },
      "2026-07-25T23:10:00Z",
      3,
    ),
    true,
  );
});

test("forecast with no target time is stale", () => {
  assert.equal(
    isForecastStale({ weatherMode: "forecast", forecastFor: null }, "2026-07-25T23:10:00Z"),
    true,
  );
});

test("only a closed roof neutralizes weather", () => {
  assert.equal(roofNeutralizesWeather({ roofState: "closed" }), true);
  assert.equal(roofNeutralizesWeather({ roofState: "open" }), false);
  assert.equal(roofNeutralizesWeather({ roofState: "none" }), false);
});
