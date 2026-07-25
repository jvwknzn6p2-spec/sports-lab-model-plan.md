import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameStatsStore } from "./store";
import { type GameStatBundle, type TeamStatSide } from "./types";

function side(teamId: number, teamName: string): TeamStatSide {
  return {
    teamId,
    teamName,
    batting: {
      teamId, teamName, season: "2024",
      runs: 480, obp: 0.33, slg: 0.42, ops: 0.75, avg: 0.255, woba: null,
      dataFlags: ["unsourced:woba"],
    },
    pitchingStaff: {
      teamId, teamName, season: "2024",
      era: 3.9, whip: 1.25, strikeoutsPer9: 8.9, inningsPitched: 902.6667, saves: 28,
      bullpenSpecific: false, recentWorkload: null,
      dataFlags: ["proxy:team_pitching_for_bullpen"],
    },
    probableStarter: null,
  };
}

function bundle(gamePk: number): GameStatBundle {
  return {
    gamePk,
    season: "2024",
    assembledAtUtc: "2024-07-25T13:00:00.000Z",
    home: side(117, "Houston Astros"),
    away: side(108, "Los Angeles Angels"),
    dataFlags: [],
  };
}

async function tempStore(): Promise<GameStatsStore> {
  return new GameStatsStore(await mkdtemp(join(tmpdir(), "sports-lab-stats-")));
}

test("save then load round-trips a bundle exactly", async () => {
  const store = await tempStore();
  assert.equal(store.has(745804), false);
  const path = await store.save(bundle(745804));
  assert.ok(existsSync(path));
  assert.equal(store.has(745804), true);
  assert.deepEqual(await store.load(745804), bundle(745804));
});

test("load returns null for an uncached game", async () => {
  const store = await tempStore();
  assert.equal(await store.load(1), null);
});

test("re-saving a game overwrites (idempotent per gamePk)", async () => {
  const store = await tempStore();
  await store.save(bundle(745804));
  const updated = bundle(745804);
  updated.home.batting.runs = 999;
  await store.save(updated);
  const loaded = await store.load(745804);
  assert.equal(loaded?.home.batting.runs, 999);
});

test("load fails loudly on a corrupted cache file", async () => {
  const store = await tempStore();
  await mkdir(join(store.rootDir, "stats"), { recursive: true });
  await writeFile(store.pathFor(745804), JSON.stringify({ gamePk: "nope" }), "utf8");
  await assert.rejects(() => store.load(745804));
});
