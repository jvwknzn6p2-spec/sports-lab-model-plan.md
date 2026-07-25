import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPitcherStatsUrl,
  buildTeamStatsUrl,
  fetchPitcherSeasonStats,
  fetchTeamBattingStats,
  fetchTeamPitchingStats,
} from "./fetch";
import { type FetchLike } from "../schedule/fetch";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
}

function stubFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}): FetchLike {
  return async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.status === 404 ? "Not Found" : "OK",
    json: async () => body,
  });
}

test("buildPitcherStatsUrl hydrates season pitching stats", () => {
  const url = buildPitcherStatsUrl(664299, "2024");
  assert.ok(url.includes("/people/664299?"));
  assert.ok(url.includes("group%3D%5Bpitching%5D") || url.includes("group=[pitching]"));
  assert.ok(url.includes("season%3D2024") || url.includes("season=2024"));
});

test("buildTeamStatsUrl encodes group and season", () => {
  const hitting = buildTeamStatsUrl(117, "hitting", "2024");
  assert.ok(hitting.includes("/teams/117/stats?"));
  assert.ok(hitting.includes("group=hitting"));
  assert.ok(hitting.includes("season=2024"));
  const pitching = buildTeamStatsUrl(117, "pitching", "2024");
  assert.ok(pitching.includes("group=pitching"));
});

test("fetch* parse via the injected impl", async () => {
  const p = await fetchPitcherSeasonStats(664299, "2024", {
    fetchImpl: stubFetch(fixture("pitcher-stats.json")),
  });
  assert.equal(p.era, 2.85);

  const b = await fetchTeamBattingStats(117, "Houston Astros", "2024", {
    fetchImpl: stubFetch(fixture("team-hitting.json")),
  });
  assert.equal(b.runs, 480);

  const t = await fetchTeamPitchingStats(117, "Houston Astros", "2024", {
    fetchImpl: stubFetch(fixture("team-pitching.json")),
  });
  assert.equal(t.era, 3.9);
});

test("fetch throws loudly on a non-2xx response", async () => {
  await assert.rejects(
    () => fetchPitcherSeasonStats(1, "2024", { fetchImpl: stubFetch({}, { ok: false, status: 404 }) }),
    /MLB stats request failed: 404/,
  );
});
