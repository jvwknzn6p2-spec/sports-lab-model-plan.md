import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBattingSanity, checkPitcherSanity, checkGameStatsSanity } from "./sanity";
import { type GameStatBundle, type TeamBattingStats, type PitcherSeasonStats } from "./types";

function batting(over: Partial<TeamBattingStats>): TeamBattingStats {
  return {
    teamId: 1,
    teamName: "Test",
    season: "2024",
    runs: 480,
    obp: 0.33,
    slg: 0.42,
    ops: 0.75,
    avg: 0.255,
    woba: null,
    dataFlags: [],
    ...over,
  };
}

test("in-range batting produces no issues", () => {
  assert.deepEqual(checkBattingSanity(batting({}), "home.batting"), []);
});

test("out-of-range batting is flagged with a path", () => {
  const issues = checkBattingSanity(batting({ obp: 1.42 }), "home.batting");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /home\.batting\.obp=1\.42 out of range/);
});

test("null values are not treated as sanity issues", () => {
  // Absence is a dataFlags concern, not a sanity concern.
  assert.deepEqual(checkBattingSanity(batting({ obp: null, runs: null }), "b"), []);
});

test("negative ERA on a pitcher is flagged", () => {
  const p: PitcherSeasonStats = {
    playerId: 1,
    fullName: "X",
    season: "2024",
    era: -1,
    whip: 1.1,
    strikeoutsPer9: 8,
    inningsPitched: 100,
    gamesStarted: 15,
    dataFlags: [],
  };
  const issues = checkPitcherSanity(p, "home.probableStarter");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /era=-1 out of range/);
});

test("checkGameStatsSanity walks both sides and the starter", () => {
  const side = {
    teamId: 1,
    teamName: "T",
    batting: batting({ obp: 2 }), // implausible
    pitchingStaff: {
      teamId: 1,
      teamName: "T",
      season: "2024",
      era: 3.9,
      whip: 1.2,
      strikeoutsPer9: 8,
      inningsPitched: 900,
      saves: 30,
      bullpenSpecific: false as const,
      recentWorkload: null,
      dataFlags: [],
    },
    probableStarter: null,
  };
  const bundle: GameStatBundle = {
    gamePk: 1,
    season: "2024",
    assembledAtUtc: "2024-07-25T12:00:00.000Z",
    home: side,
    away: side,
    dataFlags: [],
  };
  const issues = checkGameStatsSanity(bundle);
  // obp=2 flagged on both home and away.
  assert.equal(issues.length, 2);
});
