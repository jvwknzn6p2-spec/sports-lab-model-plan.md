import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assembleGameStats } from "./assemble";
import { type FetchLike } from "../schedule/fetch";
import { type ScheduledGame } from "../schedule/types";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
}

/** Route each stats URL to the matching fixture. */
function routingFetch(): FetchLike {
  return async (url) => {
    let body: unknown;
    if (url.includes("/people/")) body = fixture("pitcher-stats.json");
    else if (url.includes("group=hitting")) body = fixture("team-hitting.json");
    else if (url.includes("group=pitching")) body = fixture("team-pitching.json");
    else throw new Error(`unexpected url: ${url}`);
    return { ok: true, status: 200, statusText: "OK", json: async () => body };
  };
}

function game(over: Partial<ScheduledGame> = {}): ScheduledGame {
  return {
    gamePk: 745804,
    gameDateUtc: "2024-07-25T23:10:00Z",
    status: { abstract: "Preview", detailed: "Scheduled", coded: "S" },
    venue: { id: 2392, name: "Minute Maid Park" },
    home: { teamId: 117, teamName: "Houston Astros", probablePitcher: { id: 664299, fullName: "Framber Valdez" } },
    away: { teamId: 108, teamName: "Los Angeles Angels", probablePitcher: { id: 656302, fullName: "Tyler Anderson" } },
    doubleHeader: "N",
    gameNumber: 1,
    dataFlags: [],
    ...over,
  };
}

test("assembles both sides with batting, pitching, and starters", async () => {
  const bundle = await assembleGameStats(game(), {
    season: "2024",
    fetchImpl: routingFetch(),
    assembledAtUtc: "2024-07-25T13:00:00.000Z",
  });

  assert.equal(bundle.gamePk, 745804);
  assert.equal(bundle.season, "2024");
  assert.equal(bundle.assembledAtUtc, "2024-07-25T13:00:00.000Z");

  // Side identity comes from the schedule, not the shared stat fixtures.
  assert.equal(bundle.home.teamName, "Houston Astros");
  assert.equal(bundle.away.teamName, "Los Angeles Angels");

  assert.equal(bundle.home.batting.runs, 480);
  assert.equal(bundle.home.pitchingStaff.era, 3.9);
  assert.equal(bundle.home.probableStarter?.era, 2.85);
  assert.equal(bundle.away.probableStarter?.fullName, "Framber Valdez"); // fixture-shared

  // Aggregated flags are namespaced by side + component.
  assert.ok(bundle.dataFlags.some((f) => f.startsWith("home.batting.unsourced:woba")));
  assert.ok(bundle.dataFlags.some((f) => f.startsWith("away.pitchingStaff.proxy:team_pitching_for_bullpen")));
});

test("a missing confirmed starter yields a null probableStarter (no fabrication)", async () => {
  const g = game({
    away: { teamId: 158, teamName: "Milwaukee Brewers", probablePitcher: null },
    dataFlags: ["missing_probable_pitcher:away"],
  });
  const bundle = await assembleGameStats(g, {
    season: "2024",
    fetchImpl: routingFetch(),
    assembledAtUtc: "2024-07-25T13:00:00.000Z",
  });

  assert.equal(bundle.away.probableStarter, null);
  assert.equal(bundle.home.probableStarter?.era, 2.85);
  // The schedule-level flag is carried through, namespaced.
  assert.ok(bundle.dataFlags.includes("schedule.missing_probable_pitcher:away"));
});
