/**
 * Market-line ingestion: The Odds API events → control-tower fills.
 *
 * The policy under test is the one that matters for record integrity: an
 * entered line is NEVER overwritten, an unmatched game stays unentered
 * (no fabricated number), and doubleheaders resolve by first-pitch time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  consensusLine,
  fillControlTowerFromOdds,
  matchGameLines,
  type OddsApiEvent,
} from "../src/sources/odds-source";
import type { HandicapInput } from "../src/engine/decision";
import type { NormalizedGame } from "../src/mlb/parse";

const game = (
  gamePk: number,
  home: string,
  away: string,
  gameDate = "2026-08-21T17:05:00Z",
): NormalizedGame => ({
  gamePk,
  gameDate,
  status: "Scheduled",
  abstractState: "Preview",
  gameType: "R",
  venue: { id: null, name: null },
  home: {
    teamId: 1,
    teamName: home,
    probablePitcherId: null,
    probablePitcherName: null,
    score: null,
  },
  away: {
    teamId: 2,
    teamName: away,
    probablePitcherId: null,
    probablePitcherName: null,
    score: null,
  },
});

const event = (
  home: string,
  away: string,
  spreads: number[],
  totals: number[],
  commence = "2026-08-21T17:05:00Z",
): OddsApiEvent => ({
  commence_time: commence,
  home_team: home,
  away_team: away,
  bookmakers: spreads.map((point, i) => ({
    key: `book${i}`,
    markets: [
      {
        key: "spreads",
        outcomes: [
          { name: home, point },
          { name: away, point: -point },
        ],
      },
      ...(totals[i] !== undefined
        ? [
            {
              key: "totals",
              outcomes: [
                { name: "Over", point: totals[i] },
                { name: "Under", point: totals[i] },
              ],
            },
          ]
        : []),
    ],
  })),
});

test("consensus is the median across books, so one stale book cannot set the line", () => {
  const l = consensusLine(
    event("New York Yankees", "Boston Red Sox", [-1.5, -1.5, +2.5], [8.5, 9]),
  );
  assert.equal(l.homeLine, -1.5);
  assert.equal(l.total, 8.75);
  assert.equal(l.books, 3);
});

test("an event with no priced markets yields nulls, never a guess", () => {
  const l = consensusLine({
    commence_time: "2026-08-21T17:05:00Z",
    home_team: "A",
    away_team: "B",
    bookmakers: [],
  });
  assert.equal(l.homeLine, null);
  assert.equal(l.total, null);
});

test("doubleheaders resolve by closest first pitch, unmatched games warn", () => {
  const games = [
    game(1, "Chicago Cubs", "St. Louis Cardinals", "2026-08-21T17:20:00Z"),
    game(2, "Chicago Cubs", "St. Louis Cardinals", "2026-08-21T23:40:00Z"),
    game(3, "Seattle Mariners", "Oakland Athletics"),
  ];
  const events = [
    event("Chicago Cubs", "St. Louis Cardinals", [-1.5], [], "2026-08-21T17:20:00Z"),
    event("Chicago Cubs", "St. Louis Cardinals", [+1.5], [], "2026-08-21T23:40:00Z"),
  ];
  const { byGamePk, warnings } = matchGameLines(games, events);
  assert.equal(byGamePk.get(1)?.homeLine, -1.5);
  assert.equal(byGamePk.get(2)?.homeLine, 1.5);
  assert.equal(byGamePk.get(3), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Seattle Mariners/);
});

test("fill writes only unentered entries and never touches a human's line", () => {
  const games = [
    game(1, "New York Yankees", "Boston Red Sox"),
    game(2, "Los Angeles Dodgers", "San Diego Padres"),
  ];
  const handicaps: Record<string, HandicapInput> = {
    "1": { side: "home", notation: null }, // unentered → filled
    "2": { side: "home", notation: "1半2" }, // human line → kept
  };
  const events = [
    event("New York Yankees", "Boston Red Sox", [-1.5], [8.5]),
    event("Los Angeles Dodgers", "San Diego Padres", [-2.5], [9.5]),
  ];
  const r = fillControlTowerFromOdds(handicaps, games, events);
  assert.equal(r.linesFilled, 1);
  assert.equal(r.kept, 1);
  assert.deepEqual(handicaps["1"], { side: "home", line: -1.5, total: 8.5 });
  assert.equal(handicaps["2"]!.notation, "1半2", "the entered line survives");
  assert.equal(handicaps["2"]!.total, 9.5, "but its missing total is added");
  assert.equal(r.totalsFilled, 2);
});
