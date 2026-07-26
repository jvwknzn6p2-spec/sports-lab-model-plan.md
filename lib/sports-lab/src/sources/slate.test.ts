import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSlate } from "./slate";
import { MlbClient, type FetchLike } from "./mlb/client";
import { runDailyPipeline } from "../pipeline";

const ASOF = "2024-07-25T12:00:00Z";

/* --- MLB fixtures (same shapes the ingest tests use) ----------------------- */

const MLB = {
  teams: {
    teams: [
      { id: 108, name: "Los Angeles Angels", abbreviation: "LAA" },
      { id: 117, name: "Houston Astros", abbreviation: "HOU" },
    ],
  },
  schedule: {
    dates: [
      {
        date: "2024-07-25",
        games: [
          {
            gamePk: 745444,
            gameDate: "2024-07-25T23:00:00Z",
            gameType: "R",
            status: { abstractGameState: "Preview" },
            venue: { id: 2392, name: "Daikin Park" },
            teams: {
              away: {
                team: { id: 108, name: "Los Angeles Angels" },
                probablePitcher: { id: 656302, fullName: "Reid Detmers" },
              },
              home: {
                team: { id: 117, name: "Houston Astros" },
                probablePitcher: { id: 664285, fullName: "Framber Valdez" },
              },
            },
          },
        ],
      },
    ],
  },
  teamSchedule: {
    dates: [
      {
        date: "2024-07-24",
        games: [
          {
            gamePk: 1,
            gameDate: "2024-07-24T23:00:00Z",
            status: { abstractGameState: "Final" },
            teams: {
              home: { team: { id: 117, name: "Houston Astros" }, score: 6 },
              away: { team: { id: 108, name: "Los Angeles Angels" }, score: 2 },
            },
          },
        ],
      },
    ],
  },
  pitching: {
    stats: [
      {
        group: { displayName: "pitching" },
        splits: [{ stat: { era: "2.90", whip: "1.08", inningsPitched: "120.1" } }],
      },
    ],
  },
  hitting: {
    stats: [
      { group: { displayName: "hitting" }, splits: [{ stat: { runs: 520, gamesPlayed: 101 } }] },
    ],
  },
  bullpen: {
    stats: [{ group: { displayName: "pitching" }, splits: [{ stat: { era: "3.75" } }] }],
  },
};

const WEATHER = {
  hourly: {
    time: ["2024-07-25T23:00"],
    temperature_2m: [88],
    precipitation_probability: [20],
    wind_speed_10m: [12],
    wind_direction_10m: [180],
  },
};

const ODDS_EVENT = {
  id: "evt1",
  commence_time: "2024-07-25T23:00:00Z",
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
            { name: "Houston Astros", price: -150 },
            { name: "Los Angeles Angels", price: 130 },
          ],
        },
        {
          key: "spreads",
          outcomes: [
            { name: "Houston Astros", price: 110, point: -1.5 },
            { name: "Los Angeles Angels", price: -130, point: 1.5 },
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
};

function mlbFetch(): FetchLike {
  return async (url) => {
    const body = /\/teams\?/.test(url)
      ? MLB.teams
      : /\/schedule\?.*teamId=/.test(url)
        ? MLB.teamSchedule
        : /\/schedule\?/.test(url)
          ? MLB.schedule
          : /\/people\/\d+\/stats/.test(url)
            ? MLB.pitching
            : /group=hitting/.test(url)
              ? MLB.hitting
              : /sitCodes=rp/.test(url)
                ? MLB.bullpen
                : null;
    if (body === null) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

const okJson = (body: unknown): FetchLike => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

function slateOptions(over: Record<string, unknown> = {}) {
  return {
    asOf: ASOF,
    mlbClient: new MlbClient({ fetch: mlbFetch(), minIntervalMs: 0, sleep: async () => {} }),
    weather: { fetch: okJson(WEATHER) },
    odds: { apiKey: "k", fetch: okJson([ODDS_EVENT]) },
    ...over,
  };
}

/* -------------------------------------------------------------------------- */

test("a slate assembles from all three providers", async () => {
  const result = await fetchSlate("2024-07-25", slateOptions());

  assert.equal(result.entries.length, 1);
  assert.equal(result.problems.length, 0);

  const entry = result.entries[0];
  assert.equal(entry.game.gameId, "745444");
  assert.equal(entry.game.homeStarter?.name, "Framber Valdez");
  assert.equal(entry.context.weather.temperatureF, 88);
  assert.equal(entry.context.weather.weatherMode, "forecast");
  assert.equal(entry.odds?.moneyline?.home, -150);
  assert.equal(entry.context.ballpark.isNeutralFallback, false, "HOU should resolve park factors");
  assert.equal(entry.context.recentForm.home.sampleSize, 1);
});

test("the assembled slate runs straight through the daily pipeline", async () => {
  // The whole point: real-shaped ingest reaching a rendered report.
  const { entries } = await fetchSlate("2024-07-25", slateOptions());
  const result = await runDailyPipeline(entries, { asOf: ASOF, iterations: 4000 });

  assert.equal(result.predictions.length, 1);
  assert.equal(result.failures.length, 0);
  assert.match(result.report, /Houston Astros/);
  assert.ok(result.predictions[0].evaluation.bets.length > 0, "odds must have produced priced bets");
});

test("odds are skipped entirely when no provider is configured", async () => {
  const result = await fetchSlate("2024-07-25", slateOptions({ odds: undefined }));
  assert.equal(result.entries[0].odds, null);
  assert.equal(result.problems.length, 0, "not configuring odds is not a problem to report");
});

test("an odds outage degrades the slate but does not cancel it", async () => {
  const result = await fetchSlate(
    "2024-07-25",
    slateOptions({
      odds: { apiKey: "k", fetch: async () => ({ ok: false, status: 429, text: async () => "" }) },
    }),
  );
  assert.equal(result.entries.length, 1, "games still predict without odds");
  assert.equal(result.entries[0].odds, null);
  const problem = result.problems.find((p) => p.source === "odds")!;
  assert.match(problem.message, /quota/);
  assert.equal(problem.gameId, null, "a slate-wide failure is recorded once, not per game");
});

test("a weather outage leaves nulls so the validation layer can flag it", async () => {
  const result = await fetchSlate(
    "2024-07-25",
    slateOptions({
      weather: { fetch: async () => ({ ok: false, status: 500, text: async () => "" }) },
    }),
  );
  const entry = result.entries[0];
  assert.equal(entry.context.weather.temperatureF, null, "never a fabricated reading");
  assert.equal(result.problems.some((p) => p.source === "weather"), true);

  const run = await runDailyPipeline([entry], { asOf: ASOF, iterations: 2000 });
  assert.ok(
    run.predictions[0].validation.flags.some((f) => f.code === "weather_missing"),
    "the gap must surface as a flag",
  );
});

test("an unmatched odds event is reported per game", async () => {
  const result = await fetchSlate(
    "2024-07-25",
    slateOptions({ odds: { apiKey: "k", fetch: okJson([]) } }),
  );
  const problem = result.problems.find((p) => p.source === "odds")!;
  assert.equal(problem.gameId, "745444");
  assert.match(problem.message, /no priced event/);
});

test("injuries default to an unconfirmed lineup rather than a clean one", async () => {
  const result = await fetchSlate("2024-07-25", slateOptions());
  const injuries = result.entries[0].context.injuries;
  assert.equal(injuries.home.lineupConfirmed, false);
  assert.deepEqual(injuries.home.injuries, []);
});

test("a supplied injury source is used", async () => {
  const result = await fetchSlate(
    "2024-07-25",
    slateOptions({
      injuriesFor: (game: { home: { id: string } }, side: string) => ({
        teamId: side === "home" ? game.home.id : "108",
        injuries: [{ playerId: "x", name: "Star Hitter", status: "out", impact: "key-hitter", note: null }],
        lineupConfirmed: true,
        fetchedAt: ASOF,
      }),
    }),
  );
  assert.equal(result.entries[0].context.injuries.home.lineupConfirmed, true);
  assert.equal(result.entries[0].context.injuries.home.injuries[0].name, "Star Hitter");
});
