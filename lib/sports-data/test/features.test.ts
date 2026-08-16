import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStartingPitcherFeatures,
  buildBullpenFeatures,
  fatiguePenalty,
  RUNS_PER_EARNED_RUN,
  STARTER_FIP_PRIOR_IP,
} from "../src/features";
import type { RawPitchingLine } from "../src/sabermetrics";
import { getLeagueConstants } from "../src/sabermetrics/constants";
import { assembleGameCoreData } from "../src/step2";
import { FixtureCoreDataSource } from "../src/sources/fixture-source";
import { MlbStatsClient, MlbApiError } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import { normalizeSchedule } from "../src/mlb/parse";

const ACE: RawPitchingLine = {
  inningsPitched: "192.0",
  battersFaced: 753,
  strikeOuts: 228,
  baseOnBalls: 35,
  hitByPitch: 3,
  homeRuns: 18,
  hits: 148,
  earnedRuns: 55,
  runs: 57,
  atBats: 703,
  sacFlies: 4,
};

test("starter projection regresses toward league mean, stays FIP-based", () => {
  const f = buildStartingPitcherFeatures({ season: 2024, line: ACE });
  const c = getLeagueConstants(2024);
  assert.ok(
    f.metrics.fip !== null && f.metrics.fip < c.lgFIP,
    "ace FIP beats league",
  );
  // Regressed projection sits between the ace's FIP and league FIP.
  assert.ok(
    f.projectedFip > f.metrics.fip!,
    "projection pulled up toward mean",
  );
  assert.ok(f.projectedFip < c.lgFIP, "but still better than league");
  // expected total runs = projFIP * unearned factor.
  assert.ok(
    Math.abs(f.expectedRunsAllowedPer9 - f.projectedFip * RUNS_PER_EARNED_RUN) <
      0.02,
  );
  // reliability = IP / (IP + prior).
  const expected = 192 / (192 + STARTER_FIP_PRIOR_IP);
  assert.ok(Math.abs(f.reliability - Math.round(expected * 100) / 100) < 0.01);
});

test("park factor moves expected runs in the right direction", () => {
  const neutral = buildStartingPitcherFeatures({
    season: 2024,
    line: ACE,
    parkFactor: 100,
  });
  const hitters = buildStartingPitcherFeatures({
    season: 2024,
    line: ACE,
    parkFactor: 110,
  });
  const pitchers = buildStartingPitcherFeatures({
    season: 2024,
    line: ACE,
    parkFactor: 90,
  });
  assert.ok(hitters.projectedFip > neutral.projectedFip);
  assert.ok(pitchers.projectedFip < neutral.projectedFip);
});

test("thin samples get flagged and heavily regressed", () => {
  const tiny: RawPitchingLine = {
    inningsPitched: "12.0",
    strikeOuts: 20,
    baseOnBalls: 2,
    homeRuns: 0,
  };
  const f = buildStartingPitcherFeatures({ season: 2024, line: tiny });
  assert.ok(f.flags.some((x) => x.code === "starter_low_sample"));
  assert.ok(f.reliability < 0.25);
});

test("bullpen fatigue penalty adds expected runs", () => {
  const { penalty } = fatiguePenalty({
    last3DaysIP: 12,
    unavailableKeyArms: 1,
  });
  // (12-9)*0.06 = 0.18, +0.2 for one arm = 0.38
  assert.ok(Math.abs(penalty - 0.38) < 0.001, `penalty=${penalty}`);

  const bpLine: RawPitchingLine = {
    inningsPitched: "435.0",
    strikeOuts: 480,
    baseOnBalls: 135,
    hitByPitch: 16,
    homeRuns: 30,
    hits: 340,
    earnedRuns: 128,
    runs: 138,
    atBats: 1560,
    sacFlies: 12,
  };
  const fresh = buildBullpenFeatures({ season: 2024, line: bpLine });
  const tired = buildBullpenFeatures({
    season: 2024,
    line: bpLine,
    workload: { last3DaysIP: 12, unavailableKeyArms: 1 },
  });
  assert.ok(tired.expectedRunsAllowedPer9 > fresh.expectedRunsAllowedPer9);
  assert.equal(tired.fatiguePenalty, 0.38);
});

test("orchestrator assembles a complete game and fails loud on missing starter", async () => {
  const source = new FixtureCoreDataSource({
    date: "2024-07-25",
    season: 2024,
    games: [],
    starters: { "1": ACE },
    batting: {
      "10": {
        atBats: 5400,
        hits: 1400,
        doubles: 280,
        triples: 25,
        homeRuns: 200,
        baseOnBalls: 520,
        intentionalWalks: 30,
        hitByPitch: 55,
        sacFlies: 40,
        strikeOuts: 1300,
        plateAppearances: 6015,
      },
      "20": {
        atBats: 5400,
        hits: 1400,
        doubles: 280,
        triples: 25,
        homeRuns: 200,
        baseOnBalls: 520,
        intentionalWalks: 30,
        hitByPitch: 55,
        sacFlies: 40,
        strikeOuts: 1300,
        plateAppearances: 6015,
      },
    },
    bullpens: { "10": ACE, "20": ACE },
  });

  // Complete game: both sides fully populated.
  const complete = await assembleGameCoreData(
    {
      gamePk: 1,
      gameDate: null,
      status: null,
      abstractState: null,
      venue: { id: null, name: null },
      home: {
        teamId: 10,
        teamName: "H",
        probablePitcherId: 1,
        probablePitcherName: "P",
        score: null,
      },
      away: {
        teamId: 20,
        teamName: "A",
        probablePitcherId: 1,
        probablePitcherName: "P",
        score: null,
      },
    },
    source,
    { season: 2024 },
  );
  assert.equal(complete.complete, true);
  assert.ok(complete.home.starter && complete.away.starter);

  // Missing probable starter → downgrade flag + incomplete.
  const incomplete = await assembleGameCoreData(
    {
      gamePk: 2,
      gameDate: null,
      status: null,
      abstractState: null,
      venue: { id: null, name: null },
      home: {
        teamId: 10,
        teamName: "H",
        probablePitcherId: null,
        probablePitcherName: null,
        score: null,
      },
      away: {
        teamId: 20,
        teamName: "A",
        probablePitcherId: 1,
        probablePitcherName: "P",
        score: null,
      },
    },
    source,
    { season: 2024 },
  );
  assert.equal(incomplete.complete, false);
  assert.ok(
    incomplete.flags.some((f) => f.code === "home_no_probable_pitcher"),
  );
});

test("MLB client works over an injected fixture transport and fails loud on 4xx", async () => {
  const schedulePayload = {
    dates: [
      {
        date: "2024-07-25",
        games: [
          {
            gamePk: 99,
            teams: {
              home: {
                team: { id: 10, name: "Home" },
                probablePitcher: { id: 1, fullName: "P1" },
              },
              away: {
                team: { id: 20, name: "Away" },
                probablePitcher: { id: 2, fullName: "P2" },
              },
            },
            venue: { id: 3, name: "Park" },
          },
        ],
      },
    ],
  };
  const client = new MlbStatsClient({
    fetcher: fixtureFetcher([{ match: "/schedule", payload: schedulePayload }]),
    maxRetries: 0,
  });
  const games = normalizeSchedule(await client.schedule("2024-07-25"));
  assert.equal(games.length, 1);
  assert.equal(games[0]!.home.teamId, 10);
  assert.equal(games[0]!.away.probablePitcherId, 2);

  // Unmatched route → 404 → MlbApiError (fail loud, no retry on 4xx).
  const client404 = new MlbStatsClient({
    fetcher: fixtureFetcher([]),
    maxRetries: 2,
  });
  await assert.rejects(() => client404.pitcherSeason(1, 2024), MlbApiError);
});
