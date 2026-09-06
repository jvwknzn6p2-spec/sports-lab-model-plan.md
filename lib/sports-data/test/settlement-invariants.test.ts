/**
 * Settlement invariants the Astra review policy (.ai/ASTRA_REVIEW_POLICY.md
 * §2) treats as non-negotiable, pinned as executable spec so a change to any
 * of them is a red test and not a silent drift:
 *
 *   MLB  — settled on the FINAL score of a Final game, extra innings included.
 *   NPB  — settled on the score npb.jp posts (this repository's basis, see
 *          policy Appendix A.3); a level score is a PUSH, never a win.
 *   Both — a prediction's lock deadline precedes first pitch, so an exported
 *          `prediction_timestamp` (= the deadline) can never sit at/after
 *          `event_start_time`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import { normalizeSchedule } from "../src/mlb/parse";
import { buildResults } from "../src/sources/results-builder";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../src/sources/fixture-source";
import { assembleDate } from "../src/step2";
import { expectedRuns } from "../src/engine/run-model";
import { simulateGame } from "../src/engine/simulate";
import { decide, DEFAULT_CALIBRATION } from "../src/engine/decision";
import { settle } from "../src/engine/settle";
import { gamePredictionDeadline, MLB_DEADLINES } from "../src/engine/deadline";
import { NPB_CONFIG } from "../src/engine/league";

const here = dirname(fileURLToPath(import.meta.url));

async function demoPrediction() {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const games = await assembleDate(
    bundle.date,
    new FixtureCoreDataSource(bundle),
    { season: bundle.season },
  );
  const g = games.find((x) => x.gamePk === 745804)!;
  return decide(
    g,
    expectedRuns(g, 2024),
    simulateGame(5.4, 3.7, { sims: 5000, seed: 9 }),
    DEFAULT_CALIBRATION,
    null,
  );
}

test("MLB: a Final game that went to extra innings settles on its final score", async () => {
  // 12-inning game: the linescore carries the through-12 totals; the 9-inning
  // state (a 3-3 tie) is not what the feed reports as `score`, and must not be
  // what we settle on.
  const payload = {
    dates: [
      {
        date: "2024-07-25",
        games: [
          {
            gamePk: 745804,
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
  };
  const [normalized] = normalizeSchedule(payload as never);
  assert.equal(normalized!.home.score, 4);
  assert.equal(normalized!.away.score, 5);

  const { results } = await buildResults({
    date: "2024-07-25",
    client: new MlbStatsClient({
      fetcher: fixtureFetcher([{ match: /\/schedule/, payload }]),
      maxRetries: 0,
    }),
  });
  assert.deepEqual(results["745804"], { homeScore: 4, awayScore: 5 });

  const pred = await demoPrediction();
  const report = settle(
    "2024-07-25",
    [pred],
    results,
    DEFAULT_CALIBRATION,
    new Date("2024-07-26T12:00:00Z"),
  );
  assert.equal(report.games[0]!.actualWinner, "Detroit Tigers");
  assert.equal(report.games[0]!.winnerCorrect, false);
});

test("a level final score is a PUSH: no winner, no Brier, no win/loss counted", async () => {
  // NPB ties (after the 12th) are real results and reach settle as a level
  // score; MLB should never produce one but a glitchy feed can. Either way the
  // moneyline pushes — inventing an away win would poison the record and the
  // calibrator alike.
  const pred = await demoPrediction();
  const report = settle(
    "2024-07-25",
    [pred],
    { "745804": { homeScore: 3, awayScore: 3 } },
    DEFAULT_CALIBRATION,
    new Date("2024-07-26T12:00:00Z"),
  );
  const g = report.games[0]!;
  assert.equal(g.actualWinner, null);
  assert.equal(g.winnerCorrect, null);
  assert.equal(g.brier, null);
  assert.deepEqual(report.winnerRecord, { wins: 0, losses: 0 });
});

test("the lock deadline is strictly before first pitch for MLB and NPB", () => {
  // MLB: whole slate locks 22:59 JST the evening before; the earliest MLB
  // first pitch on a slate date is ~17:00 UTC of that date.
  const mlb = gamePredictionDeadline(
    "2026-08-30",
    "2026-08-30T16:15:00Z",
    MLB_DEADLINES,
    undefined,
  );
  assert.ok(mlb.getTime() < Date.parse("2026-08-30T16:15:00Z"));
  assert.equal(mlb.toISOString(), "2026-08-30T13:59:00.000Z");

  // NPB: per game, 33 minutes before ITS OWN first pitch.
  const npb = gamePredictionDeadline(
    "2026-09-02",
    "2026-09-02T09:00:00.000Z",
    NPB_CONFIG.deadlines,
    NPB_CONFIG.perGameLockLeadMinutes,
  );
  assert.equal(npb.toISOString(), "2026-09-02T08:27:00.000Z");
  assert.ok(npb.getTime() < Date.parse("2026-09-02T09:00:00.000Z"));
});

test("locks state the home-side probability so PASS games are scoreable on one axis", async () => {
  const pred = await demoPrediction();
  assert.equal(typeof pred.homeWinProbability, "number");
  assert.equal(typeof pred.rawHomeWinProbability, "number");
  // Consistent with the favoured-side statement the lock already carried.
  const homeFav = pred.predictedWinner === pred.home;
  const expected = homeFav ? pred.winProbability : 1 - pred.winProbability;
  assert.ok(Math.abs(pred.homeWinProbability! - expected) < 0.0015);
});
