import { test } from "node:test";
import assert from "node:assert/strict";

import { buildResults } from "../src/sources/results-builder";
import { DEFAULT_CALIBRATION } from "../src/engine/decision";
import { settle } from "../src/engine/settle";
import { demoPrediction, scheduleClient } from "./fixture-prediction";


// Post-game schedule payload (hydrate=team,linescore): one final, one live,
// one final-but-scoreless (defensive), as the live endpoint shapes them.
const RESULTS_SCHEDULE = {
  dates: [
    {
      date: "2024-07-25",
      games: [
        {
          gamePk: 745804,
          status: { detailedState: "Final", abstractGameState: "Final" },
          teams: {
            home: { team: { id: 114, name: "Cleveland Guardians" }, score: 2 },
            away: { team: { id: 116, name: "Detroit Tigers" }, score: 6 },
          },
        },
        {
          gamePk: 745812,
          status: {
            detailedState: "In Progress",
            abstractGameState: "Live",
          },
          teams: {
            home: { team: { id: 144, name: "Atlanta Braves" }, score: 3 },
            away: {
              team: { id: 143, name: "Philadelphia Phillies" },
              score: 3,
            },
          },
        },
        {
          gamePk: 745999,
          status: { detailedState: "Final", abstractGameState: "Final" },
          teams: {
            home: { team: { id: 1, name: "Broken Feed Club" } },
            away: { team: { id: 2, name: "No Score Club" }, score: 1 },
          },
        },
      ],
    },
  ],
};

test("buildResults keeps only Final games with both scores", async () => {
  const report = await buildResults({
    date: "2024-07-25",
    client: scheduleClient(RESULTS_SCHEDULE),
  });
  assert.equal(report.finals, 1);
  assert.deepEqual(report.results["745804"], { homeScore: 2, awayScore: 6 });

  assert.equal(report.pending.length, 2);
  const reasons = report.pending.map((p) => p.reason);
  assert.ok(reasons.some((r) => r.includes("not final")));
  assert.ok(reasons.some((r) => r.includes("scores missing")));
  // Live game is pending, never scored.
  assert.ok(!("745812" in report.results));
});

test("schedule failure is fatal for results too", async () => {
  await assert.rejects(() =>
    buildResults({ date: "2024-07-25", client: scheduleClient(undefined) }),
  );
});

test("fetched results settle a real prediction lock end-to-end", async () => {
  // Predict off the bundled demo slate…
  const pred = await demoPrediction();
  assert.equal(pred.pass, false);

  // …then settle with the API-fetched results (DET won 6-2 on the road).
  const { results } = await buildResults({
    date: "2024-07-25",
    client: scheduleClient(RESULTS_SCHEDULE),
  });
  const report = settle(
    "2024-07-25",
    [pred],
    results,
    DEFAULT_CALIBRATION,
    new Date("2024-07-26T12:00:00Z"),
  );
  assert.equal(report.gamesSettled, 1);
  assert.equal(report.games[0]!.actualWinner, "Detroit Tigers");
  // Forced-home pick (higher mu via seed) lost to the road team.
  assert.equal(pred.predictedWinner, "Cleveland Guardians");
  assert.equal(report.winnerRecord.losses, 1);
});
