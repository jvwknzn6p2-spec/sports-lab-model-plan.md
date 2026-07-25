import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
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

const here = dirname(fileURLToPath(import.meta.url));

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

function client(routes: Parameters<typeof fixtureFetcher>[0]) {
  return new MlbStatsClient({ fetcher: fixtureFetcher(routes), maxRetries: 0 });
}

test("buildResults keeps only Final games with both scores", async () => {
  const report = await buildResults({
    date: "2024-07-25",
    client: client([{ match: /\/schedule/, payload: RESULTS_SCHEDULE }]),
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
    buildResults({ date: "2024-07-25", client: client([]) }),
  );
});

test("fetched results settle a real prediction lock end-to-end", async () => {
  // Predict off the bundled demo slate…
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const games = await assembleDate(
    bundle.date,
    new FixtureCoreDataSource(bundle),
    { season: bundle.season },
  );
  const g = games.find((x) => x.gamePk === 745804)!;
  const pred = decide(
    g,
    expectedRuns(g, 2024),
    simulateGame(5.4, 3.7, { sims: 5000, seed: 9 }),
    DEFAULT_CALIBRATION,
    null,
  );
  assert.equal(pred.pass, false);

  // …then settle with the API-fetched results (DET won 6-2 on the road).
  const { results } = await buildResults({
    date: "2024-07-25",
    client: client([{ match: /\/schedule/, payload: RESULTS_SCHEDULE }]),
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
