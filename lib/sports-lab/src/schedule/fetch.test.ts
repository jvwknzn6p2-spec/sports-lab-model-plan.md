import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildScheduleUrl,
  fetchDailySchedule,
  fetchScheduleRaw,
  type FetchLike,
} from "./fetch";

function loadFixture(): unknown {
  const url = new URL("./__fixtures__/schedule-sample.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

/** Build a stub fetch that returns `body` with a given status. */
function stubFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: opts.status === 500 ? "Internal Server Error" : "OK",
      json: async () => body,
    };
  };
  return { fetchImpl, calls };
}

test("buildScheduleUrl encodes date, sportId and hydrate", () => {
  const url = buildScheduleUrl("2024-07-25");
  assert.ok(url.startsWith("https://statsapi.mlb.com/api/v1/schedule?"));
  assert.ok(url.includes("date=2024-07-25"));
  assert.ok(url.includes("sportId=1"));
  assert.ok(url.includes("hydrate=probablePitcher"));
});

test("buildScheduleUrl honors a custom base and sportId", () => {
  const url = buildScheduleUrl("2024-07-25", {
    baseUrl: "http://localhost:9999/api/v1",
    sportId: 11,
  });
  assert.ok(url.startsWith("http://localhost:9999/api/v1/schedule?"));
  assert.ok(url.includes("sportId=11"));
});

test("fetchDailySchedule fetches via the injected impl and parses", async () => {
  const { fetchImpl, calls } = stubFetch(loadFixture());
  const schedule = await fetchDailySchedule("2024-07-25", {
    fetchImpl,
    fetchedAtUtc: "2024-07-25T12:00:00.000Z",
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("date=2024-07-25"));
  assert.equal(schedule.games.length, 2);
  assert.equal(schedule.games[0].home.teamName, "Houston Astros");
});

test("fetchScheduleRaw throws loudly on a non-2xx response", async () => {
  const { fetchImpl } = stubFetch({}, { ok: false, status: 500 });
  await assert.rejects(
    () => fetchScheduleRaw("2024-07-25", { fetchImpl }),
    /MLB schedule request failed: 500/,
  );
});
