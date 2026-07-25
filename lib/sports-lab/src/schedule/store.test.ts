import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyScheduleStore } from "./store";
import { type DailySchedule } from "./types";

function sampleSchedule(date: string): DailySchedule {
  return {
    date,
    fetchedAtUtc: "2024-07-25T12:00:00.000Z",
    source: "mlb-stats-api",
    games: [
      {
        gamePk: 1,
        gameDateUtc: "2024-07-25T23:10:00Z",
        status: { abstract: "Preview", detailed: "Scheduled", coded: "S" },
        venue: { id: 2392, name: "Minute Maid Park" },
        home: { teamId: 117, teamName: "Houston Astros", probablePitcher: null },
        away: { teamId: 108, teamName: "Los Angeles Angels", probablePitcher: null },
        doubleHeader: "N",
        gameNumber: 1,
        dataFlags: ["missing_probable_pitcher:home", "missing_probable_pitcher:away"],
      },
    ],
  };
}

async function tempStore(): Promise<DailyScheduleStore> {
  const dir = await mkdtemp(join(tmpdir(), "sports-lab-store-"));
  return new DailyScheduleStore(dir);
}

test("save then load round-trips a schedule exactly", async () => {
  const store = await tempStore();
  const schedule = sampleSchedule("2024-07-25");

  assert.equal(store.has("2024-07-25"), false);
  const path = await store.save(schedule);
  assert.ok(existsSync(path));
  assert.equal(store.has("2024-07-25"), true);

  const loaded = await store.load("2024-07-25");
  assert.deepEqual(loaded, schedule);
});

test("save also persists the raw payload when provided", async () => {
  const store = await tempStore();
  const schedule = sampleSchedule("2024-07-25");
  const raw = { dates: [{ date: "2024-07-25", games: [] }], _capturedAt: "x" };

  await store.save(schedule, raw);
  const rawContents = await readFile(store.rawPathFor("2024-07-25"), "utf8");
  assert.deepEqual(JSON.parse(rawContents), raw);
});

test("load returns null for an uncached date", async () => {
  const store = await tempStore();
  assert.equal(await store.load("1999-01-01"), null);
});

test("re-saving a date overwrites (idempotent per date)", async () => {
  const store = await tempStore();
  await store.save(sampleSchedule("2024-07-25"));

  const updated = sampleSchedule("2024-07-25");
  updated.games[0].gamePk = 999;
  await store.save(updated);

  const loaded = await store.load("2024-07-25");
  assert.equal(loaded?.games[0].gamePk, 999);
});

test("load fails loudly on a corrupted cache file", async () => {
  const store = await tempStore();
  const path = store.pathFor("2024-07-25");
  await mkdir(join(store.rootDir, "schedule"), { recursive: true });
  await writeFile(path, JSON.stringify({ date: "2024-07-25", games: "not-an-array" }), "utf8");

  await assert.rejects(() => store.load("2024-07-25"));
});
