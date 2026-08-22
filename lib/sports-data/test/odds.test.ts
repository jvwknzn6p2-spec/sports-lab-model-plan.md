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
  devigPair,
  devigPairShin,
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

// ---- Market-implied probabilities (devigged prices) ----

const pricedEvent = (
  home: string,
  away: string,
  books: Array<{
    spread?: { point: number; home: number; away: number };
    total?: { point: number; over: number; under: number };
  }>,
): OddsApiEvent => ({
  commence_time: "2026-08-21T17:05:00Z",
  home_team: home,
  away_team: away,
  bookmakers: books.map((b, i) => ({
    key: `book${i}`,
    markets: [
      ...(b.spread
        ? [
            {
              key: "spreads",
              outcomes: [
                { name: home, point: b.spread.point, price: b.spread.home },
                { name: away, point: -b.spread.point, price: b.spread.away },
              ],
            },
          ]
        : []),
      ...(b.total
        ? [
            {
              key: "totals",
              outcomes: [
                { name: "Over", point: b.total.point, price: b.total.over },
                { name: "Under", point: b.total.point, price: b.total.under },
              ],
            },
          ]
        : []),
    ],
  })),
});

test("devig removes the vig proportionally and is side-symmetric", () => {
  // -110/-110 is the canonical balanced market: both sides imply 52.4% and
  // the fair probability is exactly 50%.
  assert.ok(Math.abs(devigPair(-110, -110) - 0.5) < 1e-9);
  assert.ok(Math.abs(devigPair(-150, 130) + devigPair(130, -150) - 1) < 1e-9);
  assert.ok(devigPair(-150, 130) > 0.5);
});

test("Shin devig sums to 1, is exact on a balanced market, and shades the longshot", () => {
  assert.ok(Math.abs(devigPairShin(-110, -110) - 0.5) < 1e-6);
  assert.ok(
    Math.abs(devigPairShin(-200, 170) + devigPairShin(170, -200) - 1) < 1e-6,
  );
  // The whole point of Shin over proportional: the margin sits mostly on the
  // longshot, so the favorite's fair probability comes out HIGHER than the
  // proportional split and the longshot's lower.
  assert.ok(devigPairShin(-200, 170) > devigPair(-200, 170));
  assert.ok(devigPairShin(170, -200) < devigPair(170, -200));
  // A pair with no overround has no margin to explain — identical to the
  // proportional split.
  assert.ok(Math.abs(devigPairShin(100, 105) - devigPair(100, 105)) < 1e-9);
});

test("consensus probability uses only books pricing the exact median point", () => {
  const l = consensusLine(
    pricedEvent("H", "A", [
      { spread: { point: -1.5, home: 100, away: -120 } },
      { spread: { point: -1.5, home: 105, away: -125 } },
      // Different point: a -2 price is a different proposition and must not
      // pollute the -1.5 consensus.
      { spread: { point: -2, home: 150, away: -170 } },
    ]),
  );
  assert.equal(l.homeLine, -1.5);
  assert.ok(l.homeCoverProb !== null);
  // Both -1.5 books price home as a slight underdog on the spread.
  assert.ok(l.homeCoverProb! < 0.5, `got ${l.homeCoverProb}`);
});

test("prices absent → probability null, line still filled", () => {
  const l = consensusLine(
    event("New York Yankees", "Boston Red Sox", [-1.5], [8.5]),
  );
  assert.equal(l.homeLine, -1.5);
  assert.equal(l.homeCoverProb, null);
  assert.equal(l.overProb, null);
});

test("the odds fill attaches market probabilities at the exact point only", () => {
  const games = [game(1, "H", "A"), game(2, "H2", "A2")];
  const events = [
    pricedEvent("H", "A", [
      {
        spread: { point: -1.5, home: -110, away: -110 },
        total: { point: 8.5, over: -105, under: -115 },
      },
    ]),
    pricedEvent("H2", "A2", [
      { spread: { point: -1.5, home: -110, away: -110 } },
    ]),
  ];
  const handicaps: Record<string, HandicapInput> = {
    "1": { side: "home", notation: null },
    // An entered line at a DIFFERENT point than the market's: the line is
    // kept and no market probability may be attached to it.
    "2": { side: "home", line: -2.5 },
  };
  const fill = fillControlTowerFromOdds(handicaps, games, events);
  assert.equal(fill.linesFilled, 1);
  assert.equal(handicaps["1"]!.line, -1.5);
  assert.ok(Math.abs(handicaps["1"]!.marketHomeCover! - 0.5) < 1e-9);
  assert.ok(handicaps["1"]!.marketOver! < 0.5); // under carries the juice (-115)
  assert.equal(handicaps["2"]!.marketHomeCover, undefined);
  assert.equal(handicaps["2"]!.line, -2.5);
});
