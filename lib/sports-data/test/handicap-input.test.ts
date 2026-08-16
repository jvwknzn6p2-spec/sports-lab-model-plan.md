/**
 * The market's own notation, end to end.
 *
 * Until now the pipeline only accepted a signed run line (-1.5), which is not
 * what this slate is quoted in. These tests drive 〈1半2〉 and friends from the
 * control-tower input through pricing, the pick label, and settlement against a
 * real score — including the worked example the notation was derived from.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decide,
  DEFAULT_CALIBRATION,
  resolveHandicap,
  type GamePrediction,
  type HandicapInput,
} from "../src/engine/decision";
import {
  expectedProfit,
  HandicapNotationError,
  settleParts,
  splitLine,
} from "../src/engine/handicap-notation";
import { settle } from "../src/engine/settle";
import { simulateGame } from "../src/engine/simulate";
import type { GameCoreData } from "../src/step2";

test("notation states what the side GIVES, so its own lines are negative", () => {
  const r = resolveHandicap({ side: "home", notation: "1半2" });
  assert.deepEqual(r.parts, [
    { line: -1.5, weight: 0.8 },
    { line: -2, weight: 0.2 },
  ]);
  assert.equal(r.giveLabel, "-〈1半2〉");
  assert.equal(r.takeLabel, "+〈1半2〉");
});

test("a signed run line still resolves, and quarter lines still split", () => {
  assert.deepEqual(resolveHandicap({ side: "home", line: -1.5 }).parts, [
    { line: -1.5, weight: 1 },
  ]);
  assert.deepEqual(splitLine(-1.25), [
    { line: -1.5, weight: 0.5 },
    { line: -1, weight: 0.5 },
  ]);
});

test("〈0〉 is なし: a level game returns the whole stake", () => {
  const r = resolveHandicap({ side: "home", notation: "0" });
  assert.deepEqual(settleParts(r.parts, 0), { win: 0, push: 1, loss: 0 });
  assert.equal(expectedProfit(settleParts(r.parts, 0)), 0);
});

test("an ambiguous or empty handicap throws rather than guessing a side", () => {
  assert.throws(
    () => resolveHandicap({ side: "home", line: -1.5, notation: "1半" }),
    HandicapNotationError,
  );
  assert.throws(() => resolveHandicap({ side: "home" }), HandicapNotationError);
  assert.throws(
    () => resolveHandicap({ side: "home", notation: "2点" }),
    HandicapNotationError,
  );
});

test("〈1半2〉 winning by two runs pays +7.2 on a 10 stake", () => {
  // The worked example, verbatim: 2点差 まる勝ちの場合 8ぶ勝ちなので +8、
  // そこから −10% で確定額は +7.2。
  const r = resolveHandicap({ side: "home", notation: "1半2" });
  const settled = settleParts(r.parts, 2);
  assert.deepEqual(settled, { win: 0.8, push: 0.2, loss: 0 });
  // 0.8 × 0.9 lands on 0.7200000000000001 in binary floating point; the stored
  // figure is rounded (see the settlement test below), so compare on money.
  assert.ok(Math.abs(expectedProfit(settled) * 10 - 7.2) < 1e-9);
});

test("the whole 1半X ladder settles as the market describes it", () => {
  const at = (notation: string, margin: number) =>
    expectedProfit(
      settleParts(resolveHandicap({ side: "home", notation }).parts, margin),
    );
  // 1半: draw and 1-run are full losses, 2 runs is a full win (less the cut).
  assert.equal(at("1半", 0), -1);
  assert.equal(at("1半", 1), -1);
  assert.equal(at("1半", 2), 0.9);
  // 1半1: 2 runs pays 9分 → +0.9 nominal → +0.81 after the cut.
  assert.ok(Math.abs(at("1半1", 2) - 0.81) < 1e-12);
  assert.equal(at("1半1", 3), 0.9);
  // 1半9: 2 runs pays only 1分.
  assert.ok(Math.abs(at("1半9", 2) - 0.09) < 1e-12);
  // Losing side of the line is a full loss at every rung.
  for (const n of ["1半", "1半1", "1半5", "1半9"]) assert.equal(at(n, -1), -1);
});

function coreGame(): GameCoreData {
  const side = {
    teamId: 1,
    teamName: "Home",
    starter: null,
    batting: null,
    bullpen: null,
    form: null,
  };
  return {
    gamePk: 1,
    gameDate: "2024-07-25T23:00:00Z",
    venue: { id: null, name: null },
    parkFactor: 100,
    home: { ...side },
    away: { ...side, teamId: 2, teamName: "Away" },
    flags: [],
    complete: true,
  };
}

function predictWith(
  handicap: HandicapInput,
  homeMu = 5.4,
  awayMu = 3.6,
): GamePrediction {
  return decide(
    coreGame(),
    { homeMu, awayMu, leagueRunsPerGame: 4.4, notes: [] },
    simulateGame(homeMu, awayMu, { sims: 20_000, seed: "notation" }),
    DEFAULT_CALIBRATION,
    handicap,
  );
}

test("a notation handicap is priced and named in the market's own terms", () => {
  // A ~3-run edge: under the overdispersed simulator a 1.8-run edge no
  // longer covers -1.5/-2 often enough to clear the commission, so the line
  // needs a genuinely strong favourite to be a bet at all.
  const p = predictWith({ side: "home", notation: "1半2" }, 6.4, 3.2);
  assert.ok(p.handicap.pick!.includes("〈1半2〉"), p.handicap.pick!);
  assert.ok(p.handicap.ev !== null);
  assert.ok(p.handicap.coverProbability! > 0.5);
});

test("〈1半2〉 is priced differently from the whole line it resembles", () => {
  // 20% of the stake sits on -2, which pushes at exactly two runs. Pricing the
  // notation as if it were a plain 1.5 would quote a push share that does not
  // exist and overstate what the bet is worth.
  const split = predictWith({ side: "home", notation: "1半2" });
  const plain = predictWith({ side: "home", line: -1.5 });
  assert.notEqual(split.handicap.ev, plain.handicap.ev);
});

test("settlement re-settles the same basket, so 8分 is scored as 8分", () => {
  const p = predictWith({ side: "home", notation: "1半2" }, 6.4, 3.2);
  assert.ok(p.handicap.pick!.startsWith("Home"), "backing the giving side");

  // Home by exactly two: the 1.5 portion wins, the 2.0 portion pushes.
  const r = settle(
    "2024-07-25",
    [p],
    { "1": { homeScore: 5, awayScore: 3 } },
    DEFAULT_CALIBRATION,
    new Date("2024-07-26T07:00:00Z"),
  );

  const g = r.games[0]!;
  assert.equal(g.handicapCorrect, true, "mostly a win");
  assert.equal(g.handicapProfit, 0.72, "but worth 8分 less the cut, not 0.9");
  assert.equal(r.handicapProfit, 0.72);
});

test("a plain line landing exactly on the margin pushes and is not scored", () => {
  // The line has to be one the engine will actually back, or there is no bet
  // to push. At a 1.8-run edge, -2 covers only 52.3% — below the 52.6%
  // break-even — so it is declined; a 4-run edge makes it a real bet.
  const p = predictWith({ side: "home", line: -2 }, 7.0, 3.0);
  assert.ok(p.handicap.pick !== null, "the bet has to be offered to push");

  const r = settle(
    "2024-07-25",
    [p],
    { "1": { homeScore: 5, awayScore: 3 } }, // margin 2 → away +2 settles at 0
    DEFAULT_CALIBRATION,
    new Date("2024-07-26T07:00:00Z"),
  );
  const g = r.games[0]!;
  assert.equal(
    g.handicapCorrect,
    null,
    "a push teaches the calibrator nothing",
  );
  assert.equal(g.handicapProfit, 0, "and costs nothing");
  assert.equal(r.handicapRecord.wins + r.handicapRecord.losses, 0);
});

test("the quoted price and the realized result cannot disagree about a push", () => {
  // Same rule, two callers: the simulator prices ten thousand imagined margins
  // with settleParts, and settlement scores the one that happened with it. A
  // line that never pushes in the simulation must never push in reality.
  const r = resolveHandicap({ side: "home", notation: "1半" });
  const sim = simulateGame(5.4, 3.6, { sims: 5_000, seed: "push" });
  assert.equal(sim.asianCover("home", r.parts).push, 0, "N.5 never pushes");
  for (let margin = -3; margin <= 3; margin++) {
    assert.equal(settleParts(r.parts, margin).push, 0);
  }
});
