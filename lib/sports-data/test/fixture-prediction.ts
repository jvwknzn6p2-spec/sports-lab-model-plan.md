/**
 * Shared test fixtures for the settlement path: the bundled 2024 demo slate
 * predicted the way `cmdPredict` does, and a schedule-backed results client.
 * Lives outside the `*.test.ts` glob so importing it never re-runs a suite.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../src/sources/fixture-source";
import { assembleDate } from "../src/step2";
import { expectedRuns } from "../src/engine/run-model";
import { simulateGame } from "../src/engine/simulate";
import {
  decide,
  DEFAULT_CALIBRATION,
  type GamePrediction,
} from "../src/engine/decision";

const here = dirname(fileURLToPath(import.meta.url));

/** gamePk of the Guardians–Tigers game in fixtures/2024-slate.json. */
export const DEMO_GAME_PK = 745804;

/** A results client answering every /schedule call with `payload`. */
export function scheduleClient(payload: unknown): MlbStatsClient {
  return new MlbStatsClient({
    fetcher: fixtureFetcher(
      payload === undefined ? [] : [{ match: /\/schedule/, payload }],
    ),
    maxRetries: 0,
  });
}

/**
 * The demo game predicted with a forced home edge (higher mu via the seeded
 * simulator), so `predictedWinner` is the home side and the pick is not a PASS.
 */
export async function demoPrediction(): Promise<GamePrediction> {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const games = await assembleDate(
    bundle.date,
    new FixtureCoreDataSource(bundle),
    { season: bundle.season },
  );
  const g = games.find((x) => x.gamePk === DEMO_GAME_PK)!;
  return decide(
    g,
    expectedRuns(g, 2024),
    simulateGame(5.4, 3.7, { sims: 5000, seed: 9 }),
    DEFAULT_CALIBRATION,
    null,
  );
}
