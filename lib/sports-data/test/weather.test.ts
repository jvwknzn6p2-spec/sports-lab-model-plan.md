/**
 * First-pitch weather: Open-Meteo parsing, the bounded temperature
 * multiplier, and the honesty rules (domes and unknown-state retractable
 * roofs are NEVER adjusted; missing data is a flag, not a guess).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWeather,
  temperatureRunMultiplier,
  weatherAtFirstPitch,
  TEMP_MULT_MAX,
  TEMP_MULT_MIN,
  type GameWeather,
  type OpenMeteoHourly,
} from "../src/sources/weather";
import {
  fetchVenueAzimuths,
  isPlausibleCfBearing,
  WIND_MULT_MAX,
  WIND_RUNS_PER_KMH_OUT,
  windRunMultiplier,
} from "../src/sources/weather";
import { expectedRuns } from "../src/engine/run-model";
import { assembleGameCoreData } from "../src/step2";
import { FixtureCoreDataSource } from "../src/sources/fixture-source";
import type { NormalizedGame } from "../src/mlb/parse";

const wx = (over: Partial<GameWeather>): GameWeather => ({
  temperatureC: 21,
  windSpeedKmh: 5,
  roof: "outdoor",
  ...over,
});

test("temperature multiplier: warm inflates, cold deflates, hard-clamped", () => {
  assert.equal(temperatureRunMultiplier(wx({ temperatureC: 21 })), 1);
  assert.ok(temperatureRunMultiplier(wx({ temperatureC: 33 })) > 1.05);
  assert.ok(temperatureRunMultiplier(wx({ temperatureC: 8 })) < 0.92 + 0.03);
  assert.equal(temperatureRunMultiplier(wx({ temperatureC: 50 })), TEMP_MULT_MAX);
  assert.equal(temperatureRunMultiplier(wx({ temperatureC: -30 })), TEMP_MULT_MIN);
});

test("domes, unknown-state roofs and missing readings are never adjusted", () => {
  assert.equal(temperatureRunMultiplier(null), 1);
  assert.equal(temperatureRunMultiplier(wx({ roof: "dome" })), 1);
  assert.equal(
    temperatureRunMultiplier(wx({ roof: "retractable", temperatureC: 35 })),
    1,
  );
  assert.equal(temperatureRunMultiplier(wx({ temperatureC: null })), 1);
});

const hourly = (temps: number[]): OpenMeteoHourly => ({
  hourly: {
    time: temps.map((_, h) => `2026-08-21T${String(h).padStart(2, "0")}:00`),
    temperature_2m: temps,
    wind_speed_10m: temps.map(() => 10),
  },
});

test("the forecast hour nearest first pitch is the one used", () => {
  const w = weatherAtFirstPitch(
    hourly([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]),
    "2026-08-21T13:40:00Z",
    "outdoor",
  );
  assert.equal(w.temperatureC, 24); // 14:00 UTC is nearest to 13:40
});

const gameAt = (gamePk: number, venueId: number | null): NormalizedGame => ({
  gamePk,
  gameDate: "2026-08-21T17:05:00Z",
  status: "Scheduled",
  abstractState: "Preview",
  gameType: "R",
  venue: { id: venueId, name: null },
  home: {
    teamId: 1,
    teamName: "H",
    probablePitcherId: null,
    probablePitcherName: null,
    score: null,
  },
  away: {
    teamId: 2,
    teamName: "A",
    probablePitcherId: null,
    probablePitcherName: null,
    score: null,
  },
});

test("buildWeather: one call per venue, domes skip the fetch, failures warn", async () => {
  const forecastCalls: string[] = [];
  const venueCalls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("statsapi.mlb.com")) {
      venueCalls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          venues: [{ id: 3, location: { azimuthAngle: 52 } }],
        }),
      };
    }
    forecastCalls.push(u);
    return {
      ok: true,
      status: 200,
      json: async () => hourly([30, 30, 30, 30, 30]),
    };
  }) as unknown as typeof fetch;

  const games = [
    gameAt(1, 3), // Fenway (outdoor)
    gameAt(2, 3), // Fenway again — same venue, one fetch
    gameAt(3, 12), // Tropicana (dome) — no fetch at all
    gameAt(4, 999), // unknown venue — warned, skipped
  ];
  const r = await buildWeather({ date: "2026-08-21", games, fetchImpl });
  assert.equal(forecastCalls.length, 1, "one fetch per unique outdoor venue");
  assert.equal(venueCalls.length, 1, "one venues call for the whole slate");
  assert.equal(r.weather["1"]!.temperatureC, 30);
  assert.equal(r.weather["1"]!.cfBearingDeg, 52);
  assert.equal(r.weather["2"]!.temperatureC, 30);
  assert.deepEqual(r.weather["3"], {
    temperatureC: null,
    windSpeedKmh: null,
    roof: "dome",
  });
  assert.equal(r.weather["4"], undefined);
  assert.equal(r.warnings.length, 1);
});

test("a hot open-air night raises both teams' expected runs symmetrically", async () => {
  const bundle = {
    date: "2026-08-21",
    season: 2024,
    games: [gameAt(1, 3)],
    starters: {},
    batting: {},
    bullpens: {},
    weather: {
      "1": wx({ temperatureC: 33 }),
    },
  };
  const cool = { ...bundle, weather: { "1": wx({ temperatureC: 21 }) } };
  const hot = await assembleGameCoreData(
    bundle.games[0]!,
    new FixtureCoreDataSource(bundle),
    { season: 2024 },
  );
  const base = await assembleGameCoreData(
    bundle.games[0]!,
    new FixtureCoreDataSource(cool),
    { season: 2024 },
  );
  const rHot = expectedRuns(hot, 2024);
  const rBase = expectedRuns(base, 2024);
  assert.ok(rHot.homeMu > rBase.homeMu, "home mu rises in the heat");
  assert.ok(rHot.awayMu > rBase.awayMu, "away mu rises too");
  assert.ok(
    Math.abs(rHot.homeMu / rBase.homeMu - rHot.awayMu / rBase.awayMu) < 0.01,
    "and by the same factor",
  );
  assert.ok(rHot.notes.some((n) => n.startsWith("Weather:")));
});

test("high wind at an open park raises a warn flag; missing weather an info flag", async () => {
  const windy = await assembleGameCoreData(
    gameAt(1, 3),
    new FixtureCoreDataSource({
      date: "2026-08-21",
      season: 2024,
      games: [gameAt(1, 3)],
      starters: {},
      batting: {},
      bullpens: {},
      weather: { "1": wx({ windSpeedKmh: 40 }) },
    }),
    { season: 2024 },
  );
  assert.ok(windy.flags.some((f) => f.code === "weather_high_wind"));

  const bare = await assembleGameCoreData(
    gameAt(1, 3),
    new FixtureCoreDataSource({
      date: "2026-08-21",
      season: 2024,
      games: [gameAt(1, 3)],
      starters: {},
      batting: {},
      bullpens: {},
    }),
    { season: 2024 },
  );
  assert.ok(
    bare.flags.some(
      (f) => f.code === "weather_missing" && f.severity === "info",
    ),
  );
});

// ---- Wind: direction × park orientation → a signed, bounded run effect ----

test("windRunMultiplier: out blows up runs, in blows them down, crosswind is neutral", () => {
  const base = {
    temperatureC: 21,
    windSpeedKmh: 16,
    cfBearingDeg: 45,
    roof: "outdoor" as const,
  };
  // Wind FROM 225° at a 45° park = blowing straight OUT to center.
  const out = windRunMultiplier(wx({ ...base, windDirectionDeg: 225 }));
  // Wind FROM 45° = coming from center field, blowing IN.
  const inn = windRunMultiplier(wx({ ...base, windDirectionDeg: 45 }));
  // Wind FROM 135° = pure crosswind.
  const cross = windRunMultiplier(wx({ ...base, windDirectionDeg: 135 }));
  assert.ok(out > 1, `out=${out}`);
  assert.ok(inn < 1, `in=${inn}`);
  assert.ok(Math.abs(cross - 1) < 1e-9, `cross=${cross}`);
  assert.ok(Math.abs(out - (1 + 16 * WIND_RUNS_PER_KMH_OUT)) < 1e-9);
});

test("windRunMultiplier is clamped and refuses dishonest inputs", () => {
  const gale = wx({
    windSpeedKmh: 60,
    windDirectionDeg: 225,
    cfBearingDeg: 45,
    roof: "outdoor",
  });
  assert.equal(windRunMultiplier(gale), WIND_MULT_MAX);
  // No bearing / no direction / not outdoor / implausible bearing → 1.0.
  assert.equal(
    windRunMultiplier(wx({ windSpeedKmh: 30, windDirectionDeg: 225, roof: "outdoor" })),
    1,
  );
  assert.equal(
    windRunMultiplier(wx({ windSpeedKmh: 30, cfBearingDeg: 45, roof: "outdoor" })),
    1,
  );
  assert.equal(
    windRunMultiplier(
      wx({ windSpeedKmh: 30, windDirectionDeg: 225, cfBearingDeg: 45, roof: "retractable" }),
    ),
    1,
  );
  // 200° sits in the SSE–NW band no MLB park points toward: a feed problem,
  // not a park — refuse the number.
  assert.equal(
    windRunMultiplier(
      wx({ windSpeedKmh: 30, windDirectionDeg: 20, cfBearingDeg: 200, roof: "outdoor" }),
    ),
    1,
  );
  assert.ok(isPlausibleCfBearing(45));
  assert.ok(!isPlausibleCfBearing(200));
});

test("fetchVenueAzimuths keeps plausible azimuths, drops the rest with a warning", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      venues: [
        { id: 3, location: { azimuthAngle: 52 } },
        { id: 17, location: { azimuthAngle: 200 } }, // implausible → dropped
        { id: 19, location: {} }, // absent → simply missing
      ],
    }),
  })) as unknown as typeof fetch;
  const r = await fetchVenueAzimuths({ venueIds: [3, 17, 19], fetchImpl });
  assert.equal(r.byVenue.get(3), 52);
  assert.equal(r.byVenue.get(17), undefined);
  assert.equal(r.byVenue.get(19), undefined);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /azimuthAngle 200/);
});
