import { test } from "node:test";
import assert from "node:assert/strict";

import {
  insertBullpenStatsSchema,
  insertGameSchema,
  insertPitcherSeasonStatsSchema,
  insertTeamBattingStatsSchema,
} from "@workspace/db/schema";

import {
  buildBullpenFeatures,
  buildStartingPitcherFeatures,
  buildTeamBattingFeatures,
} from "../src/features";
import {
  toBullpenStatsRow,
  toGameRow,
  toPitcherSeasonStatsRow,
  toTeamBattingStatsRow,
} from "../src/persist/mappers";
import type { RawBattingLine, RawPitchingLine } from "../src/sabermetrics";
import type { NormalizedGame } from "../src/mlb/parse";

const PITCH: RawPitchingLine = {
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
const BAT: RawBattingLine = {
  plateAppearances: 6015,
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
};

test("pitcher mapper output validates against the DB insert schema", () => {
  const f = buildStartingPitcherFeatures({
    pitcherId: 669373,
    season: 2024,
    line: PITCH,
  });
  const row = toPitcherSeasonStatsRow(2024, 116, PITCH, f);
  const parsed = insertPitcherSeasonStatsSchema.parse(row);
  assert.equal(parsed.mlbPersonId, 669373);
  assert.equal(parsed.strikeOuts, 228);
  assert.ok(parsed.fip !== null && parsed.fip !== undefined);
});

test("team-batting mapper output validates against the DB insert schema", () => {
  const f = buildTeamBattingFeatures({ teamId: 116, season: 2024, line: BAT });
  const row = toTeamBattingStatsRow(2024, BAT, f, 162);
  const parsed = insertTeamBattingStatsSchema.parse(row);
  assert.equal(parsed.teamMlbId, 116);
  assert.equal(parsed.gamesPlayed, 162);
  assert.ok(parsed.woba !== null && parsed.woba !== undefined);
});

test("bullpen mapper output validates against the DB insert schema", () => {
  const f = buildBullpenFeatures({
    teamId: 114,
    season: 2024,
    line: PITCH,
    workload: { last3DaysIP: 11, unavailableKeyArms: 1 },
  });
  const row = toBullpenStatsRow(2024, PITCH, f, {
    last3DaysIP: 11,
    unavailableKeyArms: 1,
  });
  const parsed = insertBullpenStatsSchema.parse(row);
  assert.equal(parsed.teamMlbId, 114);
  assert.equal(parsed.last3DaysIp, 11);
  assert.equal(parsed.unavailableKeyArms, 1);
});

test("game mapper output validates against the DB insert schema", () => {
  const game: NormalizedGame = {
    gamePk: 745804,
    gameDate: "2024-07-25T17:10:00Z",
    status: "Scheduled",
    abstractState: "Preview",
    venue: { id: 5, name: "Progressive Field" },
    away: {
      teamId: 116,
      teamName: "DET",
      probablePitcherId: 669373,
      probablePitcherName: "Skubal",
      score: null,
    },
    home: {
      teamId: 114,
      teamName: "CLE",
      probablePitcherId: 676440,
      probablePitcherName: "Bibee",
      score: null,
    },
  };
  const row = toGameRow(game, 2024, 98);
  const parsed = insertGameSchema.parse(row);
  assert.equal(parsed.gamePk, 745804);
  assert.equal(parsed.parkFactor, 98);
  assert.equal(parsed.homeTeamMlbId, 114);
});
