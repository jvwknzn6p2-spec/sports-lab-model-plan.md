import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allBallparkGeo,
  BALLPARK_GEO_COUNT,
  lookupBallparkGeo,
} from "./ballparks";
import { fetchWeather, resolveRoofState, toHourKey, WeatherProviderError } from "./openmeteo";
import {
  fetchOddsForSlate,
  matchOddsToGames,
  normalizeTeamName,
  OddsProviderError,
  toGameOdds,
  type OddsEvent,
} from "./oddsapi";
import { lookupBallparkFactors } from "../context/ballpark";
import { weatherSchema, gameOddsSchema, type CoreGame } from "../schemas";
import type { FetchLike } from "./mlb/client";

const FIRST_PITCH = "2024-07-25T23:00:00Z";
const MORNING = "2024-07-25T12:00:00Z";

/* -------------------------------------------------------------------------- */
/* Ballpark geography                                                         */
/* -------------------------------------------------------------------------- */

test("every MLB park has coordinates", () => {
  assert.equal(BALLPARK_GEO_COUNT, 30);
  for (const park of allBallparkGeo()) {
    assert.ok(park.latitude > 20 && park.latitude < 55, `${park.abbreviation} latitude`);
    assert.ok(park.longitude > -130 && park.longitude < -60, `${park.abbreviation} longitude`);
  }
});

test("the geo table and the park-factor table agree on abbreviations", () => {
  // A mismatch would mean weather resolves for a park whose run factor falls
  // back to neutral, or vice versa — a silent inconsistency between layers.
  for (const park of allBallparkGeo()) {
    const factors = lookupBallparkFactors("v", park.abbreviation);
    assert.equal(
      factors.isNeutralFallback,
      false,
      `${park.abbreviation} has coordinates but no park factors`,
    );
  }
});

test("field orientation ships unset rather than guessed", () => {
  // A bearing wrong by 90 degrees turns "wind out" into "crosswind" and
  // quietly moves every total, so these are null until measured.
  for (const park of allBallparkGeo()) {
    assert.equal(park.centerFieldBearing, null, `${park.abbreviation} should not ship a guessed bearing`);
  }
});

test("park lookup is case-insensitive and reports absence", () => {
  assert.equal(lookupBallparkGeo("hou")?.abbreviation, "HOU");
  assert.equal(lookupBallparkGeo("ZZZ"), null);
});

/* -------------------------------------------------------------------------- */
/* Roof handling                                                              */
/* -------------------------------------------------------------------------- */

test("a fixed dome is always closed; an open park is never", () => {
  assert.equal(resolveRoofState(lookupBallparkGeo("TB")!, undefined), "closed");
  assert.equal(resolveRoofState(lookupBallparkGeo("BOS")!, undefined), "none");
});

test("a retractable roof defaults to open and honours an override", () => {
  const hou = lookupBallparkGeo("HOU")!;
  assert.equal(resolveRoofState(hou, undefined), "open");
  assert.equal(resolveRoofState(hou, "closed"), "closed");
});

/* -------------------------------------------------------------------------- */
/* Weather provider                                                            */
/* -------------------------------------------------------------------------- */

const HOURLY = {
  hourly: {
    time: ["2024-07-25T22:00", "2024-07-25T23:00", "2024-07-26T00:00"],
    temperature_2m: [86, 88, 85],
    precipitation_probability: [10, 40, 30],
    wind_speed_10m: [8, 12, 9],
    wind_direction_10m: [170, 180, 190],
  },
};

function weatherFetch(body: unknown, urls: string[] = []): FetchLike {
  return async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

test("weather maps the first-pitch hour into a schema-valid record", async () => {
  const w = await fetchWeather(
    { homeAbbreviation: "HOU", firstPitch: FIRST_PITCH, asOf: MORNING },
    { fetch: weatherFetch(HOURLY) },
  );
  assert.equal(weatherSchema.safeParse(w).success, true);
  assert.equal(w.temperatureF, 88);
  assert.equal(w.windSpeedMph, 12);
  assert.equal(w.precipitationChance, 0.4, "percent must be converted to 0..1");
  assert.equal(w.fetchedAt, MORNING);
});

test("observed vs forecast is decided by the clock, not the endpoint", async () => {
  const forecast = await fetchWeather(
    { homeAbbreviation: "HOU", firstPitch: FIRST_PITCH, asOf: MORNING },
    { fetch: weatherFetch(HOURLY) },
  );
  assert.equal(forecast.weatherMode, "forecast");
  assert.equal(forecast.forecastFor, FIRST_PITCH);

  const observed = await fetchWeather(
    { homeAbbreviation: "HOU", firstPitch: FIRST_PITCH, asOf: "2024-07-26T02:00:00Z" },
    { fetch: weatherFetch(HOURLY) },
  );
  assert.equal(observed.weatherMode, "observed");
  assert.equal(observed.forecastFor, null, "an observed reading targets no future hour");
});

test("wind direction is left unresolved without a field orientation", async () => {
  const w = await fetchWeather(
    { homeAbbreviation: "HOU", firstPitch: FIRST_PITCH, asOf: MORNING },
    { fetch: weatherFetch(HOURLY) },
  );
  assert.equal(w.windRelative, null, "a compass bearing alone cannot give out/in");
  assert.equal(w.windSpeedMph, 12, "speed is still reported");
});

test("supplying a measured bearing resolves wind direction", async () => {
  const w = await fetchWeather(
    { homeAbbreviation: "HOU", firstPitch: FIRST_PITCH, asOf: MORNING },
    { fetch: weatherFetch(HOURLY), centerFieldBearings: { HOU: 0 } },
  );
  // Wind FROM 180° blows toward 0° — straight out to a north-facing centre field.
  assert.equal(w.windRelative, "out");
});

test("a missing hour yields nulls, not an error", async () => {
  const w = await fetchWeather(
    { homeAbbreviation: "HOU", firstPitch: "2024-07-25T05:00:00Z", asOf: MORNING },
    { fetch: weatherFetch(HOURLY) },
  );
  assert.equal(w.temperatureF, null);
  assert.equal(w.windSpeedMph, null);
  assert.equal(w.roofState, "open", "roof is known even when the hour is not");
});

test("an unknown park is refused rather than defaulted", async () => {
  await assert.rejects(
    () => fetchWeather({ homeAbbreviation: "ZZZ", firstPitch: FIRST_PITCH, asOf: MORNING }, { fetch: weatherFetch(HOURLY) }),
    WeatherProviderError,
  );
});

test("a changed weather response shape fails loudly", async () => {
  await assert.rejects(
    () =>
      fetchWeather(
        { homeAbbreviation: "HOU", firstPitch: FIRST_PITCH, asOf: MORNING },
        { fetch: weatherFetch({ hourly: { time: "not-an-array" } }) },
      ),
    /unexpected response shape/,
  );
});

test("the request asks for the units the library expects", async () => {
  const urls: string[] = [];
  await fetchWeather(
    { homeAbbreviation: "HOU", firstPitch: FIRST_PITCH, asOf: MORNING },
    { fetch: weatherFetch(HOURLY, urls) },
  );
  assert.match(urls[0], /temperature_unit=fahrenheit/);
  assert.match(urls[0], /wind_speed_unit=mph/);
  assert.match(urls[0], /timezone=UTC/);
  assert.match(urls[0], /latitude=29\.7572/);
});

test("toHourKey truncates to the hour in UTC", () => {
  assert.equal(toHourKey("2024-07-25T23:47:31Z"), "2024-07-25T23:00");
  assert.throws(() => toHourKey("nope"), RangeError);
});

/* -------------------------------------------------------------------------- */
/* Odds provider                                                              */
/* -------------------------------------------------------------------------- */

function game(overrides: Partial<CoreGame> = {}): CoreGame {
  return {
    gameId: "745444",
    startTime: FIRST_PITCH,
    venueId: "2392",
    venueName: "Daikin Park",
    home: { id: "117", name: "Houston Astros", abbreviation: "HOU" },
    away: { id: "108", name: "Los Angeles Angels", abbreviation: "LAA" },
    homeStarter: null,
    awayStarter: null,
    homeBatting: null,
    awayBatting: null,
    homeBullpen: null,
    awayBullpen: null,
    ...overrides,
  };
}

function event(overrides: Partial<OddsEvent> = {}): OddsEvent {
  return {
    id: "evt1",
    commence_time: FIRST_PITCH,
    home_team: "Houston Astros",
    away_team: "Los Angeles Angels",
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        last_update: "2024-07-25T11:55:00Z",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Houston Astros", price: -175 },
              { name: "Los Angeles Angels", price: 150 },
            ],
          },
          {
            key: "spreads",
            outcomes: [
              { name: "Houston Astros", price: 105, point: -1.5 },
              { name: "Los Angeles Angels", price: -125, point: 1.5 },
            ],
          },
          {
            key: "totals",
            outcomes: [
              { name: "Over", price: -110, point: 8.5 },
              { name: "Under", price: -110, point: 8.5 },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("an event maps to schema-valid GameOdds", () => {
  const odds = toGameOdds(game(), event(), MORNING);
  assert.equal(gameOddsSchema.safeParse(odds).success, true);
  assert.equal(odds.sportsbook, "DraftKings");
  assert.deepEqual(odds.moneyline, { home: -175, away: 150 });
  assert.deepEqual(odds.runLine, { line: 1.5, homePrice: 105, awayPrice: -125 });
  assert.deepEqual(odds.total, { line: 8.5, overPrice: -110, underPrice: -110 });
  assert.equal(odds.fetchedAt, "2024-07-25T11:55:00Z", "the book's own timestamp is the price time");
});

test("an away-favourite run line is refused rather than inverted", () => {
  // GameOdds models the home-lays market. Filling it from an away-favourite
  // book would price "home -1.5" with the "home +1.5" number.
  const awayFavourite = event({
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        markets: [
          {
            key: "spreads",
            outcomes: [
              { name: "Houston Astros", price: -130, point: 1.5 },
              { name: "Los Angeles Angels", price: 110, point: -1.5 },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(toGameOdds(game(), awayFavourite, MORNING).runLine, null);
});

test("mismatched over/under lines are refused", () => {
  const skewed = event({
    bookmakers: [
      {
        key: "dk",
        title: "DK",
        markets: [
          {
            key: "totals",
            outcomes: [
              { name: "Over", price: -110, point: 8.5 },
              { name: "Under", price: -110, point: 9 },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(toGameOdds(game(), skewed, MORNING).total, null);
});

test("a preferred bookmaker is chosen when present", () => {
  const multi = event({
    bookmakers: [
      { key: "fanduel", title: "FanDuel", markets: [] },
      { key: "draftkings", title: "DraftKings", markets: [] },
    ],
  });
  assert.equal(toGameOdds(game(), multi, MORNING, ["draftkings"]).sportsbook, "DraftKings");
  assert.equal(toGameOdds(game(), multi, MORNING, ["betmgm"]).sportsbook, "FanDuel", "falls back to the first");
});

test("an event with no bookmakers yields no markets rather than throwing", () => {
  const odds = toGameOdds(game(), event({ bookmakers: [] }), MORNING);
  assert.equal(odds.moneyline, null);
  assert.equal(odds.sportsbook, "none");
});

/* --- matching: the dangerous part ----------------------------------------- */

test("a game matches its event on teams and start time", () => {
  const { odds, unmatched } = matchOddsToGames([game()], [event()], MORNING);
  assert.equal(unmatched.length, 0);
  assert.equal(odds.get("745444")?.moneyline?.home, -175);
});

test("team names match despite punctuation and case differences", () => {
  assert.equal(normalizeTeamName("St. Louis Cardinals"), normalizeTeamName("st louis cardinals"));
  const { odds } = matchOddsToGames([game()], [event({ home_team: "HOUSTON ASTROS" })], MORNING);
  assert.equal(odds.size, 1);
});

test("a game with no priced event is reported, not silently dropped", () => {
  const { odds, unmatched } = matchOddsToGames([game()], [], MORNING);
  assert.equal(odds.size, 0);
  assert.equal(unmatched.length, 1);
  assert.match(unmatched[0].reason, /no priced event/);
});

test("home and away are not interchangeable", () => {
  // A swapped-sides event is a different game; matching it would invert
  // every price in the slate.
  const swapped = event({ home_team: "Los Angeles Angels", away_team: "Houston Astros" });
  const { odds, unmatched } = matchOddsToGames([game()], [swapped], MORNING);
  assert.equal(odds.size, 0);
  assert.equal(unmatched.length, 1);
});

test("a distant start time does not match, even with the right teams", () => {
  // Doubleheaders put the same two teams on the card twice.
  const nightcap = event({ commence_time: "2024-07-26T03:00:00Z" });
  const { odds } = matchOddsToGames([game()], [nightcap], MORNING, { startTimeToleranceMinutes: 90 });
  assert.equal(odds.size, 0);
});

test("an ambiguous match is refused rather than guessed", () => {
  const twin = [event({ id: "a" }), event({ id: "b" })];
  const { odds, unmatched } = matchOddsToGames([game()], twin, MORNING);
  assert.equal(odds.size, 0, "pricing one game with another's line must never happen silently");
  assert.match(unmatched[0].reason, /ambiguous/);
});

test("each game in a slate is matched independently", () => {
  const other = game({
    gameId: "999",
    home: { id: "147", name: "New York Yankees", abbreviation: "NYY" },
    away: { id: "111", name: "Boston Red Sox", abbreviation: "BOS" },
  });
  const otherEvent = event({ id: "evt2", home_team: "New York Yankees", away_team: "Boston Red Sox" });
  const { odds, unmatched } = matchOddsToGames([game(), other], [event(), otherEvent], MORNING);
  assert.equal(odds.size, 2);
  assert.equal(unmatched.length, 0);
});

/* --- transport ------------------------------------------------------------ */

test("a missing API key is named plainly", async () => {
  await assert.rejects(
    () => fetchOddsForSlate([game()], MORNING, { apiKey: "", fetch: async () => ({ ok: true, status: 200, text: async () => "[]" }) }),
    /no API key/,
  );
});

test("auth and quota failures are named, not just numbered", async () => {
  for (const [status, pattern] of [[401, /unauthorized/], [429, /quota/]] as const) {
    await assert.rejects(
      () =>
        fetchOddsForSlate([game()], MORNING, {
          apiKey: "k",
          fetch: async () => ({ ok: false, status, text: async () => "" }),
        }),
      pattern,
    );
  }
});

test("fetch and match compose into one call", async () => {
  const result = await fetchOddsForSlate([game()], MORNING, {
    apiKey: "k",
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify([event()]) }),
  });
  assert.equal(result.odds.size, 1);
  assert.equal(result.unmatched.length, 0);
});

test("a changed odds response shape fails loudly", async () => {
  await assert.rejects(
    () =>
      fetchOddsForSlate([game()], MORNING, {
        apiKey: "k",
        fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ events: [] }) }),
      }),
    /unexpected response shape/,
  );
});
