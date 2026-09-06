/**
 * Settlement invariants the Astra review policy (.ai/ASTRA_REVIEW_POLICY.md
 * §2) treats as non-negotiable, pinned as executable spec so a change to any
 * of them is a red test and not a silent drift:
 *
 *   MLB  — settled on the FINAL score of a Final game, extra innings included.
 *   NPB  — settled on the score npb.jp posts (this repository's basis, see
 *          policy Appendix A.3); a level score is a PUSH, never a win.
 *
 * Deadline-before-first-pitch is already pinned by deadline.test.ts (MLB)
 * and npb.test.ts (NPB) and is not restated here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildResults } from "../src/sources/results-builder";
import { DEFAULT_CALIBRATION } from "../src/engine/decision";
import { settle } from "../src/engine/settle";
import {
  DEMO_GAME_PK,
  demoPrediction,
  scheduleClient,
} from "./fixture-prediction";

const SETTLE_AT = new Date("2024-07-26T12:00:00Z");

test("MLB: a Final game that went to extra innings settles on its final score", async () => {
  // 12-inning game: `score` is the through-12 total; the 3-3 state after nine
  // is not in the feed and must not be what gets settled.
  const { results } = await buildResults({
    date: "2024-07-25",
    client: scheduleClient({
      dates: [
        {
          date: "2024-07-25",
          games: [
            {
              gamePk: DEMO_GAME_PK,
              status: { detailedState: "Final", abstractGameState: "Final" },
              linescore: { currentInning: 12, scheduledInnings: 9 },
              teams: {
                home: { team: { id: 114, name: "Cleveland Guardians" }, score: 4 },
                away: { team: { id: 116, name: "Detroit Tigers" }, score: 5 },
              },
            },
          ],
        },
      ],
    }),
  });
  assert.deepEqual(results[String(DEMO_GAME_PK)], { homeScore: 4, awayScore: 5 });

  const report = settle("2024-07-25", [await demoPrediction()], results, DEFAULT_CALIBRATION, SETTLE_AT);
  assert.equal(report.games[0]!.actualWinner, "Detroit Tigers");
  assert.equal(report.games[0]!.winnerCorrect, false);
});

test("a level final score is a PUSH: no winner, no Brier, no win/loss counted", async () => {
  // NPB ties (after the 12th) are real results and reach settle as a level
  // score; MLB should never produce one but a glitchy feed can. Either way the
  // moneyline pushes — inventing an away win would poison the record and the
  // calibrator alike.
  const report = settle(
    "2024-07-25",
    [await demoPrediction()],
    { [DEMO_GAME_PK]: { homeScore: 3, awayScore: 3 } },
    DEFAULT_CALIBRATION,
    SETTLE_AT,
  );
  const g = report.games[0]!;
  assert.equal(g.actualWinner, null);
  assert.equal(g.winnerCorrect, null);
  assert.equal(g.brier, null);
  assert.deepEqual(report.winnerRecord, { wins: 0, losses: 0 });
});

test("locks state the home-side probability so PASS games are scoreable on one axis", async () => {
  const pred = await demoPrediction();
  assert.equal(typeof pred.homeWinProbability, "number");
  assert.equal(typeof pred.rawHomeWinProbability, "number");
  // Consistent with the favoured-side statement the lock already carried
  // (both are round3() of the same number, so they can differ by one ulp of
  // the third decimal).
  const homeFav = pred.predictedWinner === pred.home;
  const expected = homeFav ? pred.winProbability : 1 - pred.winProbability;
  assert.ok(Math.abs(pred.homeWinProbability! - expected) < 0.0015);
});
