import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MlbStatsClient } from "../src/mlb/client";
import { fixtureFetcher } from "../src/mlb/fixtures";
import { buildForms } from "../src/sources/form-builder";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../src/sources/fixture-source";
import { assembleDate } from "../src/step2";
import {
  expectedRuns,
  FORM_OFFENSE_PRIOR_GAMES,
} from "../src/engine/run-model";

const here = dirname(fileURLToPath(import.meta.url));

/** A past day's schedule with one final game at the given score. */
const finalDay = (gamePk: number, homeScore: number, awayScore: number) => ({
  dates: [
    {
      games: [
        {
          gamePk,
          status: { detailedState: "Final", abstractGameState: "Final" },
          teams: {
            home: { team: { id: 114, name: "CLE" }, score: homeScore },
            away: { team: { id: 116, name: "DET" }, score: awayScore },
          },
        },
      ],
    },
  ],
});

function client(routes: Parameters<typeof fixtureFetcher>[0]) {
  return new MlbStatsClient({ fetcher: fixtureFetcher(routes), maxRetries: 0 });
}

test("buildForms collects the most recent N finals per team", async () => {
  // Three past days: CLE scores 10, 2, 6 (target window = 2 → only 10 and 2).
  const fm = await buildForms({
    date: "2024-07-25",
    client: client([
      { match: /date=2024-07-24/, payload: finalDay(901, 10, 1) },
      { match: /date=2024-07-23/, payload: finalDay(902, 2, 5) },
      { match: /date=2024-07-22/, payload: finalDay(903, 6, 0) },
    ]),
    teamIds: [114, 116],
    gamesTarget: 2,
    maxDays: 5,
  });
  const cle = fm.forms["114"]!;
  assert.equal(cle.games, 2);
  assert.equal(cle.runsScoredPerGame, 6); // (10+2)/2 — day 3 excluded
  assert.equal(cle.runsAllowedPerGame, 3); // (1+5)/2
  // Early stop: both teams filled after 2 days.
  assert.equal(fm.daysScanned, 2);
  assert.deepEqual(fm.warnings, []);
});

test("short windows and unreachable days are fail-soft with warnings", async () => {
  const fm = await buildForms({
    date: "2024-07-25",
    client: client([
      { match: /date=2024-07-24/, payload: finalDay(901, 4, 3) },
      // All other days 404.
    ]),
    teamIds: [114, 116, 999],
    gamesTarget: 3,
    maxDays: 3,
  });
  assert.equal(fm.forms["114"]!.games, 1);
  assert.ok(!("999" in fm.forms));
  assert.ok(fm.warnings.some((w) => w.includes("schedule unavailable")));
  assert.ok(fm.warnings.some((w) => w.includes("team 999: only 0/3")));
});

test("run model blends form: hot bats raise mu, opposing hot bats via RA raise opponent mu", async () => {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;

  const baseline = (
    await assembleDate("2024-07-25", new FixtureCoreDataSource(bundle), {
      season: 2024,
    })
  ).find((g) => g.gamePk === 745804)!;
  const base = expectedRuns(baseline, 2024);

  // CLE (home, 114) red-hot: 6.5 R/G over 15; DET ice cold: 2.5 R/G.
  const withForm = JSON.parse(JSON.stringify(bundle)) as FixtureBundle;
  withForm.forms = {
    "114": { games: 15, runsScoredPerGame: 6.5, runsAllowedPerGame: 4.5 },
    "116": { games: 15, runsScoredPerGame: 2.5, runsAllowedPerGame: 4.2 },
  };
  const adjusted = (
    await assembleDate("2024-07-25", new FixtureCoreDataSource(withForm), {
      season: 2024,
    })
  ).find((g) => g.gamePk === 745804)!;
  assert.equal(adjusted.home.form!.runsScoredPerGame, 6.5);
  const adj = expectedRuns(adjusted, 2024);

  // Hot home bats → home mu up; cold away bats → away mu down.
  assert.ok(adj.homeMu > base.homeMu, `${adj.homeMu} > ${base.homeMu}`);
  assert.ok(adj.awayMu < base.awayMu, `${adj.awayMu} < ${base.awayMu}`);
  // Regression: a +2.4 R/G form gap moves mu by well under 2.4 (≈30% weight).
  const w = 15 / (15 + FORM_OFFENSE_PRIOR_GAMES);
  assert.ok(adj.homeMu - base.homeMu < 2.4 * w + 0.35);
  // Notable form differences show up as explainable notes.
  assert.ok(adj.notes.some((n) => n.includes("hot bats")));
  assert.ok(adj.notes.some((n) => n.includes("cold bats")));
});

test("missing form leaves the run model untouched", async () => {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const games = await assembleDate(
    "2024-07-25",
    new FixtureCoreDataSource(bundle),
    { season: 2024 },
  );
  const g = games[0]!;
  assert.equal(g.home.form, null);
  const runs = expectedRuns(g, 2024);
  assert.ok(!runs.notes.some((n) => n.includes("bats")));
});
