import { test } from "node:test";
import assert from "node:assert/strict";

import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import { buildSlate } from "../src/sources/slate-builder";
import { FixtureCoreDataSource } from "../src/sources/fixture-source";
import { assembleDate } from "../src/step2";

// Raw MLB Stats API payload shapes, as the live endpoints return them.
const SCHEDULE = {
  dates: [
    {
      date: "2024-07-25",
      games: [
        {
          gamePk: 111,
          gameDate: "2024-07-25T17:10:00Z",
          status: { detailedState: "Scheduled" },
          teams: {
            home: {
              team: { id: 10, name: "Home Club" },
              probablePitcher: { id: 1, fullName: "Home Ace" },
            },
            away: {
              team: { id: 20, name: "Away Club" },
              probablePitcher: { id: 2, fullName: "Away Ace" },
            },
          },
          venue: { id: 5, name: "Test Park" },
        },
      ],
    },
  ],
};

const pitcherStats = (k: number) => ({
  stats: [
    {
      splits: [
        {
          stat: {
            inningsPitched: "150.1",
            battersFaced: 600,
            strikeOuts: k,
            baseOnBalls: 40,
            hitByPitch: 4,
            homeRuns: 15,
            hits: 130,
            earnedRuns: 55,
            runs: 60,
            atBats: 560,
            sacFlies: 4,
          },
        },
      ],
    },
  ],
});

const TEAM_BATTING = {
  stats: [
    {
      splits: [
        {
          stat: {
            plateAppearances: 4000,
            atBats: 3600,
            hits: 900,
            doubles: 170,
            triples: 15,
            homeRuns: 120,
            baseOnBalls: 320,
            intentionalWalks: 10,
            hitByPitch: 40,
            sacFlies: 25,
            strikeOuts: 900,
          },
        },
      ],
    },
  ],
};

const TEAM_BULLPEN = {
  stats: [
    {
      splits: [
        {
          stat: {
            inningsPitched: "400.0",
            battersFaced: 1700,
            strikeOuts: 420,
            baseOnBalls: 140,
            hitByPitch: 15,
            homeRuns: 40,
            hits: 350,
            earnedRuns: 160,
            runs: 170,
            atBats: 1520,
            sacFlies: 12,
          },
        },
      ],
    },
  ],
};

function clientWithRoutes(routes: Parameters<typeof fixtureFetcher>[0]) {
  return new MlbStatsClient({ fetcher: fixtureFetcher(routes), maxRetries: 0 });
}

const FULL_ROUTES = [
  { match: /\/schedule/, payload: SCHEDULE },
  { match: /\/people\/1\/stats/, payload: pitcherStats(180) },
  { match: /\/people\/2\/stats/, payload: pitcherStats(140) },
  { match: /\/teams\/10\/stats\?.*group=hitting/, payload: TEAM_BATTING },
  { match: /\/teams\/20\/stats\?.*group=hitting/, payload: TEAM_BATTING },
  { match: /\/teams\/10\/stats\?.*sitCodes=rp/, payload: TEAM_BULLPEN },
  { match: /\/teams\/20\/stats\?.*sitCodes=rp/, payload: TEAM_BULLPEN },
];

test("buildSlate wires schedule + stats into a complete bundle", async () => {
  const report = await buildSlate({
    date: "2024-07-25",
    season: 2024,
    client: clientWithRoutes(FULL_ROUTES),
  });
  assert.equal(report.games, 1);
  assert.equal(report.startersFetched, 2);
  assert.equal(report.startersExpected, 2);
  assert.equal(report.teamsFetched, 2);
  assert.deepEqual(report.warnings, []);

  const b = report.bundle;
  assert.equal(b.date, "2024-07-25");
  assert.equal(b.games[0]!.home.probablePitcherId, 1);
  assert.equal(b.starters["1"]!.strikeOuts, 180);
  assert.equal(b.batting["10"]!.homeRuns, 120);
  assert.equal(b.bullpens["20"]!.baseOnBalls, 140);
});

test("fetched slate feeds the full predict pipeline (COMPLETE game)", async () => {
  const { bundle } = await buildSlate({
    date: "2024-07-25",
    season: 2024,
    client: clientWithRoutes(FULL_ROUTES),
  });
  const games = await assembleDate(
    "2024-07-25",
    new FixtureCoreDataSource(bundle),
    { season: 2024 },
  );
  assert.equal(games.length, 1);
  assert.equal(games[0]!.complete, true);
  assert.ok(games[0]!.home.starter!.metrics.fip !== null);
});

test("a failing entity is fail-soft: warning + omitted, schedule failure is fatal", async () => {
  // Starter 2's stats endpoint 404s; everything else succeeds.
  const routes = FULL_ROUTES.filter(
    (r) => String(r.match) !== String(/\/people\/2\/stats/),
  );
  const report = await buildSlate({
    date: "2024-07-25",
    season: 2024,
    client: clientWithRoutes(routes),
  });
  assert.equal(report.startersFetched, 1);
  assert.ok(!("2" in report.bundle.starters));
  assert.ok(report.warnings.some((w) => w.startsWith("starter 2:")));

  // The gap becomes a downgrade at predict time, not a fabricated number.
  const games = await assembleDate(
    "2024-07-25",
    new FixtureCoreDataSource(report.bundle),
    { season: 2024 },
  );
  assert.equal(games[0]!.complete, false);
  assert.ok(
    games[0]!.flags.some((f) => f.code === "away_starter_stats_missing"),
  );

  // No schedule → loud throw.
  await assert.rejects(() =>
    buildSlate({
      date: "2024-07-25",
      season: 2024,
      client: clientWithRoutes([]),
    }),
  );
});

test("games without probable starters are kept but warned", async () => {
  const noSp = structuredClone(SCHEDULE);
  delete (noSp.dates[0]!.games[0]!.teams.home as { probablePitcher?: unknown })
    .probablePitcher;
  const report = await buildSlate({
    date: "2024-07-25",
    season: 2024,
    client: clientWithRoutes([
      { match: /\/schedule/, payload: noSp },
      ...FULL_ROUTES.slice(1),
    ]),
  });
  assert.equal(report.games, 1);
  assert.equal(report.startersExpected, 1);
  assert.ok(report.warnings.some((w) => w.includes("no probable starter")));
});
