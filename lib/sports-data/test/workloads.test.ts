import { test } from "node:test";
import assert from "node:assert/strict";

import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import { buildWorkloads, previousDates } from "../src/sources/workload-builder";
import { buildBullpenFeatures } from "../src/features";
import type { RawPitchingLine } from "../src/sabermetrics";

// Past-date schedule: one final game (boxscore available), one live game
// (must be skipped — no usage counted for it).
const daySchedule = (gamePk: number, finalPk = true) => ({
  dates: [
    {
      games: [
        {
          gamePk,
          status: {
            detailedState: finalPk ? "Final" : "In Progress",
            abstractGameState: finalPk ? "Final" : "Live",
          },
          teams: {
            home: { team: { id: 114, name: "CLE" } },
            away: { team: { id: 116, name: "DET" } },
          },
        },
      ],
    },
  ],
});

// Boxscore: starter (gamesStarted 1) must NOT count; two relievers do.
// CLE relief: 2.1 + 1.0 = 3.1 IP (10 outs). DET relief: 3.0 IP (9 outs).
const BOXSCORE = {
  teams: {
    home: {
      team: { id: 114 },
      players: {
        ID100: {
          stats: { pitching: { inningsPitched: "6.0", gamesStarted: 1 } },
        },
        ID101: {
          stats: { pitching: { inningsPitched: "2.1", gamesStarted: 0 } },
        },
        ID102: {
          stats: { pitching: { inningsPitched: "1.0", gamesStarted: 0 } },
        },
        ID103: { stats: {} }, // position player — no pitching line
      },
    },
    away: {
      team: { id: 116 },
      players: {
        ID200: {
          stats: { pitching: { inningsPitched: "6.0", gamesStarted: 1 } },
        },
        ID201: {
          stats: { pitching: { inningsPitched: "3.0", gamesStarted: 0 } },
        },
      },
    },
  },
};

function client(routes: Parameters<typeof fixtureFetcher>[0]) {
  return new MlbStatsClient({ fetcher: fixtureFetcher(routes), maxRetries: 0 });
}

test("previousDates walks back N days across month boundaries", () => {
  assert.deepEqual(previousDates("2024-08-02", 3), [
    "2024-08-01",
    "2024-07-31",
    "2024-07-30",
  ]);
  assert.throws(() => previousDates("bogus", 3));
});

test("buildWorkloads sums relief IP only, across multiple days", async () => {
  // Same final game appears on two of the three past days; the third day's
  // game is live and must be skipped.
  const wl = await buildWorkloads({
    date: "2024-07-25",
    client: client([
      { match: /date=2024-07-24/, payload: daySchedule(901) },
      { match: /date=2024-07-23/, payload: daySchedule(902) },
      { match: /date=2024-07-22/, payload: daySchedule(903, false) },
      { match: /\/game\/901\/boxscore/, payload: BOXSCORE },
      { match: /\/game\/902\/boxscore/, payload: BOXSCORE },
    ]),
  });
  assert.equal(wl.gamesScanned, 2);
  // CLE: (10+10) outs = 6.7 IP; DET: (9+9) outs = 6.0 IP. Starters excluded.
  assert.equal(wl.workloads["114"]!.last3DaysIP, 6.7);
  assert.equal(wl.workloads["116"]!.last3DaysIP, 6.0);
  assert.deepEqual(wl.warnings, []);
});

test("failures are fail-soft: warnings, partial data, never a throw", async () => {
  const wl = await buildWorkloads({
    date: "2024-07-25",
    client: client([
      { match: /date=2024-07-24/, payload: daySchedule(901) },
      // 901's boxscore missing; other two days' schedules missing entirely.
    ]),
  });
  assert.deepEqual(wl.workloads, {});
  assert.equal(wl.gamesScanned, 0);
  assert.ok(wl.warnings.some((w) => w.includes("boxscore unavailable")));
  assert.ok(wl.warnings.some((w) => w.includes("schedule unavailable")));
});

test("auto workloads drive the fatigue penalty in bullpen features", async () => {
  const heavyDay = {
    teams: {
      home: {
        team: { id: 114 },
        players: {
          ID100: {
            stats: { pitching: { inningsPitched: "4.0", gamesStarted: 1 } },
          },
          ID101: {
            stats: { pitching: { inningsPitched: "5.0", gamesStarted: 0 } },
          },
        },
      },
      away: { team: { id: 116 }, players: {} },
    },
  };
  const wl = await buildWorkloads({
    date: "2024-07-25",
    client: client([
      { match: /date=2024-07-24/, payload: daySchedule(901) },
      { match: /date=2024-07-23/, payload: daySchedule(902) },
      { match: /date=2024-07-22/, payload: daySchedule(903) },
      { match: /\/game\/90\d\/boxscore/, payload: heavyDay },
    ]),
  });
  // 5 relief IP × 3 days = 15 IP → over the 9-IP threshold.
  assert.equal(wl.workloads["114"]!.last3DaysIP, 15.0);

  const penLine: RawPitchingLine = {
    inningsPitched: "400.0",
    strikeOuts: 420,
    baseOnBalls: 140,
    homeRuns: 40,
  };
  const features = buildBullpenFeatures({
    teamId: 114,
    season: 2024,
    line: penLine,
    workload: wl.workloads["114"],
  });
  assert.ok(features.fatiguePenalty > 0);
  assert.ok(features.flags.some((f) => f.code === "bullpen_heavy_usage"));
});
