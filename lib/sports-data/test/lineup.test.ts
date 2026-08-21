/**
 * Posted-lineup offense: slot-weighted, per-player-regressed wOBA replacing
 * the team-season baseline — and every honesty rule around it (no partial
 * nines, league-average fill for statless bats, nothing guessed when no
 * lineup is posted).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLineupBattingFeatures,
  LINEUP_SLOT_PA_SHARE,
  type LineupPlayerInput,
} from "../src/features/lineup";
import { parseScheduleLineups } from "../src/mlb/parse";
import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import { buildSlate } from "../src/sources/slate-builder";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../src/sources/fixture-source";
import { assembleDate } from "../src/step2";
import type { RawBattingLine } from "../src/sabermetrics";

/** A hitter's line at roughly the given quality (hits scale with `hitRate`). */
const bat = (pa: number, hitRate: number): RawBattingLine => ({
  plateAppearances: pa,
  atBats: Math.round(pa * 0.88),
  hits: Math.round(pa * 0.88 * hitRate),
  doubles: Math.round(pa * 0.05),
  triples: 2,
  homeRuns: Math.round(pa * 0.03),
  baseOnBalls: Math.round(pa * 0.09),
  hitByPitch: 3,
  sacFlies: 3,
  strikeOuts: Math.round(pa * 0.22),
});

const nine = (line: RawBattingLine | null): LineupPlayerInput[] =>
  Array.from({ length: 9 }, (_, i) => ({
    playerId: 100 + i,
    name: `Bat ${i + 1}`,
    line,
  }));

test("slot shares sum to one and the leadoff spot outweighs the nine hole", () => {
  const sum = LINEUP_SLOT_PA_SHARE.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(LINEUP_SLOT_PA_SHARE[0]! > LINEUP_SLOT_PA_SHARE[8]!);
});

test("a strong nine projects a higher wOBA than a weak nine", () => {
  const strong = buildLineupBattingFeatures({
    season: 2024,
    players: nine(bat(500, 0.32)),
  })!;
  const weak = buildLineupBattingFeatures({
    season: 2024,
    players: nine(bat(500, 0.21)),
  })!;
  assert.ok(strong.projectedWoba > weak.projectedWoba);
  assert.equal(strong.playersWithData, 9);
  assert.equal(strong.flags.length, 0);
});

test("the same hitter matters more at leadoff than in the nine hole", () => {
  const others = nine(bat(500, 0.25));
  const star = { playerId: 999, name: "Star", line: bat(500, 0.36) };
  const starLeadoff = buildLineupBattingFeatures({
    season: 2024,
    players: [star, ...others.slice(1)],
  })!;
  const starNinth = buildLineupBattingFeatures({
    season: 2024,
    players: [...others.slice(1), star],
  })!;
  assert.ok(starLeadoff.projectedWoba > starNinth.projectedWoba);
});

test("statless bats fill at league average with a flag; partial nines are refused", () => {
  const holes = buildLineupBattingFeatures({
    season: 2024,
    players: [...nine(bat(500, 0.3)).slice(0, 7), ...nine(null).slice(0, 2)],
  })!;
  assert.equal(holes.playersWithData, 7);
  assert.ok(holes.flags.some((f) => f.code === "lineup_bats_missing_stats"));
  const full = buildLineupBattingFeatures({
    season: 2024,
    players: nine(bat(500, 0.3)),
  })!;
  assert.ok(holes.reliability < full.reliability);

  assert.equal(
    buildLineupBattingFeatures({
      season: 2024,
      players: nine(bat(500, 0.3)).slice(0, 8),
    }),
    null,
  );
});

test("parseScheduleLineups keeps full nines and drops partial sides", () => {
  const players = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({
      id: from + i,
      fullName: `P${from + i}`,
    }));
  const res = {
    dates: [
      {
        games: [
          {
            gamePk: 1,
            lineups: { homePlayers: players(9), awayPlayers: players(9, 20) },
          },
          { gamePk: 2, lineups: { homePlayers: players(6) } },
          { gamePk: 3 },
        ],
      },
    ],
  };
  const parsed = parseScheduleLineups(res);
  assert.equal(parsed["1"]!.home.length, 9);
  assert.equal(parsed["1"]!.away.length, 9);
  assert.equal(parsed["1"]!.home[0]!.playerId, 1);
  assert.equal(parsed["2"], undefined); // 6 bats is not a lineup
  assert.equal(parsed["3"], undefined);
});

test("the assembler re-bases offense on a posted lineup and flags it", async () => {
  const teamLine = bat(4000, 0.26);
  const bundle: FixtureBundle = {
    date: "2024-07-25",
    season: 2024,
    games: [
      {
        gamePk: 7,
        gameDate: "2024-07-25T17:10:00Z",
        status: "Scheduled",
        abstractState: "Preview",
        gameType: "R",
        venue: { id: 5, name: null },
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
          probablePitcherId: null,
          probablePitcherName: null,
          score: null,
        },
      },
    ],
    starters: {},
    batting: { "10": teamLine, "20": teamLine },
    bullpens: {},
    lineups: {
      "7": {
        home: Array.from({ length: 9 }, (_, i) => ({
          playerId: 100 + i,
          name: `H${i}`,
        })),
        away: [], // not posted
      },
    },
    lineupBatting: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        String(100 + i),
        bat(450, 0.33), // tonight's nine hit better than the season blend
      ]),
    ),
  };
  const [g] = await assembleDate("2024-07-25", new FixtureCoreDataSource(bundle), {
    season: 2024,
  });
  assert.ok(g!.home.lineup, "home lineup features built");
  assert.ok(
    g!.home.batting!.projectedWoba > g!.away.batting!.projectedWoba,
    "posted strong nine outrates the season baseline",
  );
  assert.ok(g!.home.batting!.flags.some((f) => f.code === "lineup_applied"));
  assert.equal(g!.away.lineup, null);
  assert.ok(
    g!.flags.some((f) => f.code === "away_lineup_not_posted"),
    g!.flags.map((f) => f.code).join(","),
  );
});

test("buildSlate carries posted lineups and bulk-fetches their bats", async () => {
  const players = (from: number) =>
    Array.from({ length: 9 }, (_, i) => ({ id: from + i, fullName: `P${from + i}` }));
  const schedule = {
    dates: [
      {
        date: "2024-07-25",
        games: [
          {
            gamePk: 111,
            gameDate: "2024-07-25T17:10:00Z",
            status: { detailedState: "Scheduled" },
            teams: {
              home: { team: { id: 10, name: "Home Club" } },
              away: { team: { id: 20, name: "Away Club" } },
            },
            venue: { id: 5, name: "Test Park" },
            lineups: { homePlayers: players(100), awayPlayers: players(200) },
          },
        ],
      },
    ],
  };
  const people = {
    people: Array.from({ length: 18 }, (_, i) => ({
      id: i < 9 ? 100 + i : 200 + (i - 9),
      stats: [
        {
          splits: [
            {
              stat: {
                plateAppearances: 400,
                atBats: 360,
                hits: 100,
                doubles: 20,
                triples: 2,
                homeRuns: 12,
                baseOnBalls: 30,
                hitByPitch: 4,
                sacFlies: 3,
                strikeOuts: 80,
              },
            },
          ],
        },
      ],
    })),
  };
  const client = new MlbStatsClient({
    fetcher: fixtureFetcher([
      { match: /\/schedule/, payload: schedule },
      { match: /\/people\?personIds=/, payload: people },
    ]),
    maxRetries: 0,
  });
  const report = await buildSlate({ date: "2024-07-25", season: 2024, client });
  assert.equal(report.lineupsPosted, 1);
  assert.equal(report.lineupBatsFetched, 18);
  assert.equal(report.bundle.lineups!["111"]!.home.length, 9);
  assert.ok(report.bundle.lineupBatting!["100"]);
});
