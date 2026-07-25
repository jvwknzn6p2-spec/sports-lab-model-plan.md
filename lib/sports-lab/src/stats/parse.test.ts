import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parsePitcherSeasonStats,
  parseTeamBattingStats,
  parseTeamPitchingStats,
  StatsParseError,
} from "./parse";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
}

test("parsePitcherSeasonStats reads a season line and converts IP thirds", () => {
  const p = parsePitcherSeasonStats(fixture("pitcher-stats.json"), { season: "2024" });
  assert.equal(p.playerId, 664299);
  assert.equal(p.fullName, "Framber Valdez");
  assert.equal(p.era, 2.85);
  assert.equal(p.whip, 1.1);
  assert.equal(p.strikeoutsPer9, 8.5);
  assert.equal(p.gamesStarted, 20);
  // "120.1" is 120 + 1/3, not 120.1
  assert.ok(Math.abs((p.inningsPitched ?? 0) - (120 + 1 / 3)) < 1e-9);
  assert.deepEqual(p.dataFlags, []);
});

test("parsePitcherSeasonStats flags a pitcher with no season stats (never fakes)", () => {
  const p = parsePitcherSeasonStats(fixture("pitcher-no-stats.json"), { season: "2024" });
  assert.equal(p.era, null);
  assert.equal(p.inningsPitched, null);
  assert.ok(p.dataFlags.includes("no_stats:pitching"));
  assert.ok(p.dataFlags.includes("unsourced:era"));
});

test("parseTeamBattingStats captures rates and flags wOBA as unsourced", () => {
  const b = parseTeamBattingStats(fixture("team-hitting.json"), {
    season: "2024",
    teamId: 117,
    teamName: "Houston Astros",
  });
  assert.equal(b.runs, 480);
  assert.equal(b.obp, 0.33);
  assert.equal(b.slg, 0.42);
  assert.equal(b.ops, 0.75);
  assert.equal(b.avg, 0.255);
  // wOBA is not in the free API — must be null and explicitly flagged.
  assert.equal(b.woba, null);
  assert.ok(b.dataFlags.includes("unsourced:woba"));
});

test("parseTeamPitchingStats is a labeled bullpen proxy, IP in thirds", () => {
  const t = parseTeamPitchingStats(fixture("team-pitching.json"), {
    season: "2024",
    teamId: 117,
    teamName: "Houston Astros",
  });
  assert.equal(t.era, 3.9);
  assert.equal(t.saves, 28);
  assert.ok(Math.abs((t.inningsPitched ?? 0) - (902 + 2 / 3)) < 1e-9);
  assert.equal(t.bullpenSpecific, false);
  assert.equal(t.recentWorkload, null);
  assert.ok(t.dataFlags.includes("proxy:team_pitching_for_bullpen"));
});

test("parsers fail loudly on a structurally broken payload", () => {
  assert.throws(() => parsePitcherSeasonStats({ nope: true }, { season: "2024" }), StatsParseError);
  assert.throws(
    () => parseTeamBattingStats({ stats: "not-an-array" }, { season: "2024", teamId: 1, teamName: "X" }),
    StatsParseError,
  );
});
