/**
 * Step 9 review layer: payload honesty and panel assembly. The Anthropic
 * call is behind ReviewModel, so these tests run offline with a fake.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewPayload,
  REVIEWER_ROLES,
  reviewToMarkdown,
  runAiReview,
  type ReviewModel,
} from "../src/engine/ai-review";
import { DEFAULT_CALIBRATION, type GamePrediction } from "../src/engine/decision";

const prediction = (over: Partial<GamePrediction>): GamePrediction => ({
  gamePk: 1,
  gameDate: "2026-08-21T17:05:00Z",
  home: "Home",
  away: "Away",
  pass: false,
  predictedWinner: "Home",
  predictedLoser: "Away",
  winProbability: 0.61,
  rawWinProbability: 0.63,
  confidence: "B",
  handicap: {
    input: { side: "home", line: -1.5 },
    pick: "Home -1.5",
    coverProbability: 0.55,
    rawCoverProbability: 0.56,
    ev: 0.02,
    noValue: false,
  },
  total: {
    line: 8.5,
    predicted: 8.9,
    pick: "OVER",
    probability: 0.54,
    rawProbability: 0.55,
  },
  expectedRuns: { home: 5.1, away: 3.8 },
  reasons: ["Starter edge: Home"],
  flags: ["[info] home_starter_xfip_estimated"],
  ...over,
});

test("the payload carries picks, flags, calibration, IL and weather — and says LOCKED", () => {
  const payload = buildReviewPayload({
    date: "2026-08-21",
    predictions: [prediction({})],
    calibration: DEFAULT_CALIBRATION,
    bundle: {
      date: "2026-08-21",
      season: 2026,
      games: [
        {
          gamePk: 1,
          gameDate: "2026-08-21T17:05:00Z",
          status: null,
          abstractState: null,
          gameType: null,
          venue: { id: 3, name: null },
          home: {
            teamId: 7,
            teamName: "Home",
            probablePitcherId: null,
            probablePitcherName: null,
            score: null,
          },
          away: {
            teamId: 8,
            teamName: "Away",
            probablePitcherId: null,
            probablePitcherName: null,
            score: null,
          },
        },
      ],
      starters: {},
      batting: {},
      bullpens: {},
      injuries: {
        "7": [{ name: "Ace Starter", position: "P", status: "60-Day IL" }],
      },
      weather: {
        "1": { temperatureC: 31, windSpeedKmh: 12, roof: "outdoor" },
      },
    },
  });
  const parsed = JSON.parse(payload);
  assert.match(parsed.note, /LOCKED/);
  assert.deepEqual(Object.keys(parsed.playersOnIl), ["Home"]);
  assert.equal(parsed.games[0].weather.temperatureC, 31);
  assert.equal(parsed.games[0].statedWinProbability, 0.61);
  assert.equal(parsed.calibrationState.shrink, DEFAULT_CALIBRATION.shrink);
});

test("every reviewer gets the same payload and its own charter; markdown keeps role order", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const fake: ReviewModel = {
    async complete(system, user) {
      calls.push({ system, user });
      return `### Findings\n- ok\n### Verdict\nclean (${calls.length})`;
    },
  };
  const payload = buildReviewPayload({
    date: "2026-08-21",
    predictions: [prediction({})],
    calibration: DEFAULT_CALIBRATION,
  });
  const result = await runAiReview(payload, fake);
  assert.equal(calls.length, REVIEWER_ROLES.length);
  assert.ok(calls.every((c) => c.user === payload), "same payload to all");
  assert.ok(
    new Set(calls.map((c) => c.system)).size === REVIEWER_ROLES.length,
    "each role has its own charter",
  );
  assert.ok(
    calls.every((c) => /ONLY from the JSON payload/.test(c.system)),
    "no-outside-facts rule is in every charter",
  );

  const md = reviewToMarkdown("2026-08-21", result);
  assert.match(md, /Advisory only/);
  const order = REVIEWER_ROLES.map((r) => md.indexOf(`## ${r.title}`));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)));
});
