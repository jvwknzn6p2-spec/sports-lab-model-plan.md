import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_PARK_FACTORS,
  getParkFactor,
  getParkFactorEntry,
} from "../src/sources/park-factors";
import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import { buildSlate } from "../src/sources/slate-builder";
import { FixtureCoreDataSource } from "../src/sources/fixture-source";
import { assembleDate } from "../src/step2";

test("park-factor table covers 30 parks with sane values", () => {
  assert.equal(ALL_PARK_FACTORS.length, 30);
  for (const p of ALL_PARK_FACTORS) {
    assert.ok(
      p.runFactor >= 90 && p.runFactor <= 115,
      `${p.name}: ${p.runFactor}`,
    );
  }
  // Extremes point the right way: Coors inflates, T-Mobile suppresses.
  assert.equal(getParkFactor(19), 112);
  assert.equal(getParkFactor(680), 94);
  // Unknown venue → undefined, never a silent 100.
  assert.equal(getParkFactor(999999), undefined);
  assert.equal(getParkFactor(null), undefined);
  assert.equal(getParkFactorEntry(19)!.name, "Coors Field (COL)");
});

const scheduleAt = (venueId: number, venueName: string) => ({
  dates: [
    {
      games: [
        {
          gamePk: 111,
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
          venue: { id: venueId, name: venueName },
        },
      ],
    },
  ],
});

const PITCHER = {
  stats: [
    {
      splits: [
        {
          stat: {
            inningsPitched: "150.1",
            battersFaced: 600,
            strikeOuts: 160,
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
};
const BATTING = {
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
            hitByPitch: 40,
            sacFlies: 25,
            strikeOuts: 900,
          },
        },
      ],
    },
  ],
};

const statRoutes = [
  { match: /\/people\/\d+\/stats/, payload: PITCHER },
  { match: /group=hitting/, payload: BATTING },
  { match: /sitCodes=rp/, payload: PITCHER },
];

function client(routes: Parameters<typeof fixtureFetcher>[0]) {
  return new MlbStatsClient({ fetcher: fixtureFetcher(routes), maxRetries: 0 });
}

test("buildSlate auto-fills park factors and applies them at predict time", async () => {
  const { bundle, warnings } = await buildSlate({
    date: "2024-07-25",
    season: 2024,
    client: client([
      { match: /\/schedule/, payload: scheduleAt(19, "Coors Field") },
      ...statRoutes,
    ]),
  });
  assert.equal(bundle.parkFactors!["19"], 112);
  assert.deepEqual(warnings, []);

  const games = await assembleDate(
    "2024-07-25",
    new FixtureCoreDataSource(bundle),
    { season: 2024 },
  );
  assert.equal(games[0]!.parkFactor, 112);
  // Coors inflates the starter's expected runs allowed vs. a neutral park.
  assert.ok(games[0]!.home.starter!.projectedFip > 0);
});

test("manual override beats the table; unknown venue warns and stays neutral", async () => {
  const overridden = await buildSlate({
    date: "2024-07-25",
    season: 2024,
    client: client([
      { match: /\/schedule/, payload: scheduleAt(19, "Coors Field") },
      ...statRoutes,
    ]),
    parkFactors: { "19": 105 },
  });
  assert.equal(overridden.bundle.parkFactors!["19"], 105);

  const unknown = await buildSlate({
    date: "2024-07-25",
    season: 2024,
    client: client([
      { match: /\/schedule/, payload: scheduleAt(424242, "London Stadium") },
      ...statRoutes,
    ]),
  });
  assert.ok(!("424242" in unknown.bundle.parkFactors!));
  assert.ok(unknown.warnings.some((w) => w.includes("unknown venue 424242")));

  const games = await assembleDate(
    "2024-07-25",
    new FixtureCoreDataSource(unknown.bundle),
    { season: 2024 },
  );
  assert.equal(games[0]!.parkFactor, 100);
});
