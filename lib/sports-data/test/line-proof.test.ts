import { test } from "node:test";
import assert from "node:assert/strict";

import {
  quotableNotations,
  verifyLineSettlement,
} from "../src/engine/line-proof";
import { DEFAULT_CALIBRATION, type GamePrediction } from "../src/engine/decision";
import { settle } from "../src/engine/settle";

test("every quotable real line settles correctly, both sides, every margin", () => {
  const proof = verifyLineSettlement();
  assert.deepEqual(
    proof.failures,
    [],
    proof.failures.map((f) => `〈${f.notation}〉 ${f.code}: ${f.detail}`).join("\n"),
  );
  // The sweep must actually be a sweep: the plain tenths and the whole 半
  // family, priced from both sides, booked both ways.
  assert.equal(proof.notations.length, quotableNotations().length);
  assert.ok(proof.cases > 3000, `only ${proof.cases} cases`);
  assert.ok(proof.backed.home > 0 && proof.backed.away > 0);
  assert.ok(proof.checks > proof.cases, "each case carries several checks");
  // Nothing here may quietly become a pick'em: `0` is not a real line.
  assert.ok(!proof.notations.includes("0"));
});

test("the 分 ladder is the published one, in units after the cut", () => {
  const proof = verifyLineSettlement({ notations: ["1半", "1半2", "1半9"], margins: [2] });
  assert.deepEqual(proof.failures, []);
  const byNotation = new Map(proof.ladder.map((r) => [r.notation, r]));
  // 〈1半2〉 winning by exactly two: 8分 of the stake, less 10% → +0.72.
  assert.equal(byNotation.get("1半2")!.profit, 0.72);
  assert.equal(byNotation.get("1半2")!.push, 0.2);
  assert.equal(byNotation.get("1半")!.profit, 0.9);
  assert.equal(byNotation.get("1半9")!.profit, 0.09);
});

function predictionOn(
  backed: "home" | "away" | undefined,
  pick: string,
): GamePrediction {
  return {
    gamePk: 1,
    gameDate: null,
    home: "Bears",
    away: "Wolves",
    pass: false,
    predictedWinner: "Bears",
    predictedLoser: "Wolves",
    winProbability: 0.58,
    rawWinProbability: 0.6,
    confidence: "B",
    handicap: {
      input: { side: "home", notation: "1半2" },
      pick,
      ...(backed === undefined ? {} : { backed }),
      coverProbability: 0.56,
      rawCoverProbability: 0.57,
      ev: 0.04,
      noValue: false,
    },
    total: {
      line: null,
      predicted: 9,
      pick: null,
      probability: null,
      rawProbability: null,
    },
    expectedRuns: { home: 5, away: 4 },
    reasons: [],
    flags: [],
  };
}

/** Home wins by two — the margin where 〈1半2〉 splits. */
const WIN_BY_TWO = { "1": { homeScore: 5, awayScore: 3 } };

test("settlement follows the recorded side, not the wording of the label", () => {
  // Backing the giving side at 〈1半2〉 and winning by exactly two pays 8分
  // less the cut; backing the taking side loses the 80% and pushes the rest.
  const giving = settle(
    "2026-08-19",
    [predictionOn("home", "Bears -〈1半2〉")],
    WIN_BY_TWO,
    DEFAULT_CALIBRATION,
    new Date(0),
  ).games[0]!;
  assert.equal(giving.handicapProfit, 0.72);

  const taking = settle(
    "2026-08-19",
    [predictionOn("away", "Wolves +〈1半2〉")],
    WIN_BY_TWO,
    DEFAULT_CALIBRATION,
    new Date(0),
  ).games[0]!;
  assert.equal(taking.handicapProfit, -0.8);

  // The recorded side is authoritative: a label that disagrees with it cannot
  // flip the money. (This is the failure the field exists to prevent — at a
  // pick'em both readings settle identically and nothing would show.)
  const mislabelled = settle(
    "2026-08-19",
    [predictionOn("away", "Bears -〈1半2〉")],
    WIN_BY_TWO,
    DEFAULT_CALIBRATION,
    new Date(0),
  ).games[0]!;
  assert.equal(mislabelled.handicapProfit, -0.8);
});

test("locks written before the side was recorded still settle off the label", () => {
  const legacy = settle(
    "2026-08-19",
    [predictionOn(undefined, "Bears -〈1半2〉")],
    WIN_BY_TWO,
    DEFAULT_CALIBRATION,
    new Date(0),
  ).games[0]!;
  assert.equal(legacy.handicapProfit, 0.72);

  const legacyTaking = settle(
    "2026-08-19",
    [predictionOn(undefined, "Wolves +〈1半2〉")],
    WIN_BY_TWO,
    DEFAULT_CALIBRATION,
    new Date(0),
  ).games[0]!;
  assert.equal(legacyTaking.handicapProfit, -0.8);
});
