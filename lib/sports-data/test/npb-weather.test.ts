/**
 * NPB first-pitch weather: the 12-park site table, the shared builder
 * pointed at it, and the NPB-specific honesty rules — wind stays
 * direction-blind (no orientation feed), domes and retractable roofs are
 * never adjusted, and a 地方開催 game (venueId null) gets no weather.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildNpbWeather, npbVenueSite } from "../src/npb/weather";
import { NPB_TEAMS } from "../src/npb/teams";
import {
  temperatureRunMultiplier,
  windRunMultiplier,
  type OpenMeteoHourly,
} from "../src/sources/weather";
import type { NormalizedGame } from "../src/mlb/parse";

test("every NPB club's main park has a site; roof types match reality", () => {
  for (const t of NPB_TEAMS) {
    const site = npbVenueSite(t.venueId);
    assert.ok(site, `${t.fullName} (${t.homeVenue}) missing from the site table`);
    assert.equal(site.venueId, t.venueId);
  }
  assert.equal(npbVenueSite(9101)!.roof, "dome"); // 東京ドーム
  assert.equal(npbVenueSite(9109)!.roof, "outdoor"); // ZOZOマリン
  assert.equal(npbVenueSite(9108)!.roof, "retractable"); // エスコンフィールド
  assert.equal(npbVenueSite(9110)!.roof, "dome"); // ベルーナドーム: 開放壁でも保守的に無調整
  assert.equal(npbVenueSite(null), undefined); // 地方開催
});

const hourly = (temp: number, windKmh: number): OpenMeteoHourly => ({
  hourly: {
    time: Array.from({ length: 24 }, (_, h) => `2026-08-22T${String(h).padStart(2, "0")}:00`),
    temperature_2m: Array.from({ length: 24 }, () => temp),
    wind_speed_10m: Array.from({ length: 24 }, () => windKmh),
    wind_direction_10m: Array.from({ length: 24 }, () => 225),
  },
});

const npbGame = (gamePk: number, venueId: number | null): NormalizedGame => ({
  gamePk,
  gameDate: "2026-08-22T09:00:00Z", // 18:00 JST first pitch
  status: "Scheduled",
  abstractState: "Preview",
  gameType: "R",
  venue: { id: venueId, name: null },
  home: {
    teamId: 909,
    teamName: "H",
    probablePitcherId: null,
    probablePitcherName: null,
    score: null,
  },
  away: {
    teamId: 910,
    teamName: "A",
    probablePitcherId: null,
    probablePitcherName: null,
    score: null,
  },
});

test("buildNpbWeather: outdoor fetched, domes recorded fetch-free, no azimuth call, 地方開催 skipped", async () => {
  const forecastCalls: string[] = [];
  let statsapiCalled = false;
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("statsapi.mlb.com")) {
      statsapiCalled = true;
      return { ok: true, status: 200, json: async () => ({ venues: [] }) };
    }
    forecastCalls.push(u);
    return { ok: true, status: 200, json: async () => hourly(31, 40) };
  }) as unknown as typeof fetch;

  const games = [
    npbGame(1, 9109), // ZOZOマリン (outdoor)
    npbGame(2, 9101), // 東京ドーム — no fetch at all
    npbGame(3, null), // 地方開催 — warned, skipped
  ];
  const r = await buildNpbWeather({ date: "2026-08-22", games, fetchImpl });

  assert.equal(forecastCalls.length, 1, "one fetch for the one outdoor venue");
  assert.ok(!statsapiCalled, "NPB must never call the MLB venues feed");

  const zozo = r.weather["1"]!;
  assert.equal(zozo.temperatureC, 31);
  assert.equal(zozo.cfBearingDeg, null, "no orientation feed → null bearing");
  assert.ok(temperatureRunMultiplier(zozo) > 1, "31°C open air inflates runs");
  assert.equal(
    windRunMultiplier(zozo),
    1,
    "direction-blind: wind never becomes a signed multiplier",
  );

  assert.deepEqual(r.weather["2"], {
    temperatureC: null,
    windSpeedKmh: null,
    roof: "dome",
  });
  assert.equal(r.weather["3"], undefined);
  assert.equal(r.warnings.length, 1, "the 地方開催 venue is warned, not guessed");
});

test("retractable NPB roof records the reading but never adjusts", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => hourly(35, 10),
  })) as unknown as typeof fetch;
  const r = await buildNpbWeather({
    date: "2026-08-22",
    games: [npbGame(1, 9108)], // エスコンフィールド
    fetchImpl,
  });
  const w = r.weather["1"]!;
  assert.equal(w.roof, "retractable");
  assert.equal(w.temperatureC, 35, "reading kept for the audit trail");
  assert.equal(temperatureRunMultiplier(w), 1, "…but never applied");
});
