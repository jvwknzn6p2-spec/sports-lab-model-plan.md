/**
 * IL detection: roster → IL list → informational flag. Never a number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildInjuries } from "../src/sources/injuries-builder";
import { MlbStatsClient } from "../src/mlb/client";
import { assembleGameCoreData } from "../src/step2";
import { FixtureCoreDataSource } from "../src/sources/fixture-source";
import type { NormalizedGame } from "../src/mlb/parse";

const rosterPayload = {
  roster: [
    {
      person: { id: 1, fullName: "Ace Starter" },
      position: { abbreviation: "P" },
      status: { code: "D60", description: "60-Day Injured List" },
    },
    {
      person: { id: 2, fullName: "Healthy Bat" },
      position: { abbreviation: "1B" },
      status: { code: "A", description: "Active" },
    },
    {
      person: { id: 3, fullName: "Sore Elbow" },
      position: { abbreviation: "RP" },
      status: { code: "D15", description: "15-Day Injured List" },
    },
  ],
};

test("buildInjuries keeps only D-coded (IL) players, fail-soft per team", async () => {
  const client = new MlbStatsClient({
    fetcher: (async (url: string) => {
      if (String(url).includes("/teams/7/")) {
        return { ok: true, status: 200, json: async () => rosterPayload };
      }
      return { ok: false, status: 404, statusText: "nf", json: async () => ({}) };
    }) as never,
    maxRetries: 0,
  });
  const r = await buildInjuries({ client, teamIds: [7, 8], season: 2026 });
  assert.deepEqual(
    r.injuries["7"]!.map((p) => p.name),
    ["Ace Starter", "Sore Elbow"],
  );
  assert.equal(r.injuries["8"], undefined, "failed team stays absent");
  assert.equal(r.warnings.length, 1);
});

test("an IL list surfaces as an [info] flag naming the players", async () => {
  const game: NormalizedGame = {
    gamePk: 1,
    gameDate: "2026-08-21T17:05:00Z",
    status: "Scheduled",
    abstractState: "Preview",
    gameType: "R",
    venue: { id: null, name: null },
    home: {
      teamId: 7,
      teamName: "H",
      probablePitcherId: null,
      probablePitcherName: null,
      score: null,
    },
    away: {
      teamId: 8,
      teamName: "A",
      probablePitcherId: null,
      probablePitcherName: null,
      score: null,
    },
  };
  const g = await assembleGameCoreData(
    game,
    new FixtureCoreDataSource({
      date: "2026-08-21",
      season: 2026,
      games: [game],
      starters: {},
      batting: {},
      bullpens: {},
      injuries: {
        "7": [{ name: "Ace Starter", position: "P", status: "60-Day Injured List" }],
        "8": [],
      },
    }),
    { season: 2026 },
  );
  const flag = g.flags.find((f) => f.code === "home_players_on_il");
  assert.ok(flag && flag.severity === "info");
  assert.match(flag!.message, /Ace Starter \(P\)/);
  assert.equal(
    g.flags.some((f) => f.code === "away_players_on_il"),
    false,
    "an empty IL is not a flag",
  );
  assert.deepEqual(g.away.ilPlayers, []);
});
