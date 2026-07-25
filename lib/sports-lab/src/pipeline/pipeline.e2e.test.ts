/**
 * End-to-end test over the whole loop, offline.
 *
 * This drives the real sources, the real parsers, the real model and the real
 * store against synthetic fixtures in the exact JSON shapes the live APIs
 * return. It is the check that Steps 1-7 plus record/analyse/improve actually
 * connect — the thing unit tests on individual stages cannot tell us.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig, type RuntimeConfig } from "../config";
import { gradeDay } from "../loop/score";
import { analyseGraded } from "../loop/analyze";
import { DEFAULT_CALIBRATION } from "../loop/calibration";
import { formatDailyReport } from "../report/text";
import { Store } from "../store/store";
import {
  SYNTHETIC_DATE,
  SYNTHETIC_GAMES,
  writeSyntheticFixtures,
} from "../testing/syntheticSlate";
import { createSources } from "./collect";
import { predictDate } from "./predict";

const MISMATCH_GAME = SYNTHETIC_GAMES[0]!.gamePk; // strong home team, hot, wind out
const EVEN_GAME = SYNTHETIC_GAMES[1]!.gamePk; // two average teams, cold, wind in

async function setup(options: { final?: boolean } = {}): Promise<{
  config: RuntimeConfig;
  dataDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sports-lab-e2e-"));
  const fixtureDir = path.join(root, "fixtures");
  const dataDir = path.join(root, "data");
  await writeSyntheticFixtures(fixtureDir, options);
  return {
    dataDir,
    config: loadRuntimeConfig({
      offline: true,
      fixtureDir,
      dataDir,
      season: 2026,
      simulations: 20000,
      oddsApiKey: "synthetic-key",
      oddsBook: "draftkings",
    }),
  };
}

test("the full slate is predicted from fixtures", async () => {
  const { config } = await setup();
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });

  assert.equal(daily.games.length, 2, "both games should be predicted");
  assert.equal(daily.skipped.length, 0);
  assert.equal(daily.date, SYNTHETIC_DATE);

  for (const game of daily.games) {
    const sum = game.calibrated.homeWinProbability + game.calibrated.awayWinProbability;
    assert.ok(Math.abs(sum - 1) < 1e-9, "win probabilities must sum to 1");
    assert.ok(
      game.calibrated.predictedTotal > 4 && game.calibrated.predictedTotal < 16,
      `implausible total ${game.calibrated.predictedTotal}`,
    );
    assert.ok(game.baseline.teams.home.adjustments.length > 0, "the trail must be populated");
  }
});

test("the model favours the better team by a sensible margin", async () => {
  const { config } = await setup();
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });

  const mismatch = daily.games.find((g) => g.gamePk === MISMATCH_GAME);
  assert.ok(mismatch, "mismatch game missing");
  // 4.8 R/G + a 3.05 RA9 ace + a good bullpen, against 3.9 R/G and a 5.70 RA9
  // rookie. That should be a clear but not absurd favourite.
  assert.ok(
    mismatch.calibrated.homeWinProbability > 0.65,
    `expected a clear favourite, got ${mismatch.calibrated.homeWinProbability}`,
  );
  assert.ok(
    mismatch.calibrated.homeWinProbability < 0.9,
    `no MLB game is this certain: ${mismatch.calibrated.homeWinProbability}`,
  );
  assert.equal(mismatch.moneylinePick.team.abbrev, "HCH");

  const even = daily.games.find((g) => g.gamePk === EVEN_GAME);
  assert.ok(even, "even game missing");
  assert.ok(
    Math.abs(even.calibrated.homeWinProbability - 0.5) < 0.1,
    `two average teams should be near a coin flip, got ${even.calibrated.homeWinProbability}`,
  );
});

test("weather and pitching flow through to the predicted total", async () => {
  const { config } = await setup();
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });

  const hotWindOut = daily.games.find((g) => g.gamePk === MISMATCH_GAME)!;
  const coldWindIn = daily.games.find((g) => g.gamePk === EVEN_GAME)!;

  const hotWeather = hotWindOut.baseline.teams.home.adjustments.find((a) => a.name === "weather")!;
  const coldWeather = coldWindIn.baseline.teams.home.adjustments.find((a) => a.name === "weather")!;
  assert.ok(hotWeather.multiplier > 1.05, `84F with wind out: ${hotWeather.multiplier}`);
  assert.ok(hotWeather.note.includes("out to CF"));
  assert.ok(coldWeather.multiplier < 0.96, `62F with wind in: ${coldWeather.multiplier}`);
  assert.ok(coldWeather.note.includes("in to CF"));

  assert.ok(
    hotWindOut.calibrated.predictedTotal > coldWindIn.calibrated.predictedTotal,
    "the hot, wind-out game should project more runs",
  );
});

test("a real bullpen aggregate is built from the league pitcher pool", async () => {
  const { config } = await setup();
  const sources = createSources(config);
  const bullpen = await sources.bullpens.profile(
    { id: 901, name: "Harbor City Herons", abbrev: "HCH" },
    null,
  );
  assert.ok(bullpen, "bullpen aggregate missing");
  // Six relievers at 45 innings each; the starter in the same pool is excluded.
  assert.equal(bullpen.pitcherCount, 6, "starters must be filtered out of the bullpen");
  assert.ok(Math.abs(bullpen.reliefInningsPitched - 270) < 1e-6);
  // Runs allowed are whole numbers, so a fixture cannot express an arbitrary
  // RA9 exactly: 18 runs over 45 innings is 3.60, the closest reachable value
  // to the 3.50 the fixture asks for.
  assert.ok(
    Math.abs((bullpen.runsAllowedPer9 as number) - 3.6) < 0.01,
    `expected 3.60 RA9 from 18 runs in 45 innings, got ${bullpen.runsAllowedPer9}`,
  );
  assert.ok(
    (bullpen.runsAllowedPer9 as number) < 4.45,
    "the Herons bullpen must still read as clearly better than league average",
  );
});

test("an unknown ballpark degrades loudly and caps the rank", async () => {
  const { config } = await setup();
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });

  for (const game of daily.games) {
    assert.equal(game.context.park.matched, false, "synthetic parks are not in the table");
    assert.equal(game.context.park.runs, 1, "an unknown park must be neutral, not guessed");
    assert.ok(
      game.issues.some((i) => i.code === "park_factor_unknown"),
      "the fallback must be reported as an issue",
    );
    assert.ok(
      game.confidence.caps.some((c) => c.includes("park-factor table")),
      "and must cap the confidence rank",
    );
    assert.notEqual(game.confidence.rank, "S");
  }
});

test("no game can be ranked S while the calibration is unfitted", async () => {
  const { config } = await setup();
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });
  for (const game of daily.games) {
    assert.notEqual(game.confidence.rank, "S");
    assert.ok(
      game.confidence.caps.some((c) => c.includes("never been scored")),
      `expected the uncalibrated cap, got: ${game.confidence.caps.join(" | ")}`,
    );
  }
});

test("odds are matched to the right game and priced", async () => {
  const { config } = await setup();
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });

  const mismatch = daily.games.find((g) => g.gamePk === MISMATCH_GAME)!;
  assert.ok(mismatch.context.odds, "odds should have matched");
  assert.equal(mismatch.context.odds.book, "DraftKings");
  assert.equal(mismatch.context.odds.moneyline?.home, -145);
  assert.equal(mismatch.context.odds.total?.line, 9);
  assert.equal(mismatch.context.odds.runLine?.homeHandicap, -1.5);
  // Moneyline (2) + run line (2) + total (2).
  assert.equal(mismatch.bets.length, 6);

  const even = daily.games.find((g) => g.gamePk === EVEN_GAME)!;
  assert.equal(even.context.odds?.runLine, null, "game 2 has no spread priced");
  assert.equal(even.bets.length, 4, "so only 4 markets should be evaluated");
  assert.ok(
    even.issues.some((i) => i.field === "odds.runLine"),
    "the missing market must be reported",
  );

  for (const bet of mismatch.bets) {
    assert.ok(bet.fairProbability > 0 && bet.fairProbability < 1);
    assert.ok(Math.abs(bet.edge - (bet.modelProbability - bet.fairProbability)) < 1e-12);
  }
  // Both sides of a de-vigged market must sum to 1.
  const moneylines = mismatch.bets.filter((b) => b.market === "moneyline");
  const fairSum = moneylines.reduce((sum, b) => sum + b.fairProbability, 0);
  assert.ok(Math.abs(fairSum - 1) < 1e-9, `fair probabilities summed to ${fairSum}`);
});

test("re-running the same date reproduces identical numbers", async () => {
  const first = await setup();
  const second = await setup();
  const a = await predictDate({
    date: SYNTHETIC_DATE,
    config: first.config,
    calibration: DEFAULT_CALIBRATION,
  });
  const b = await predictDate({
    date: SYNTHETIC_DATE,
    config: second.config,
    calibration: DEFAULT_CALIBRATION,
  });
  for (let i = 0; i < a.games.length; i++) {
    assert.equal(
      a.games[i]?.calibrated.homeWinProbability,
      b.games[i]?.calibrated.homeWinProbability,
    );
    assert.equal(a.games[i]?.simulation.meanTotal, b.games[i]?.simulation.meanTotal);
  }
});

test("the report renders the plan's card format", async () => {
  const { config } = await setup();
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });
  const report = formatDailyReport(daily);

  for (const expected of [
    "AI SPORTS LAB",
    SYNTHETIC_DATE,
    "BEST BETS",
    "ALL GAMES",
    "DATA NOTES",
    "Moneyline:",
    "Run line:",
    "Total:",
    "Confidence:",
    "Flags:",
    "Harbor City Herons",
  ]) {
    assert.ok(report.includes(expected), `report is missing "${expected}"`);
  }
  assert.ok(
    report.includes("decision support"),
    "the report must carry the uncertainty reminder",
  );
});

test("predictions round-trip through the store", async () => {
  const { config, dataDir } = await setup();
  const store = new Store(dataDir);
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config,
    calibration: DEFAULT_CALIBRATION,
  });
  await store.savePredictions(daily);

  const reloaded = await store.loadPredictions(SYNTHETIC_DATE);
  assert.ok(reloaded, "predictions should reload");
  assert.equal(reloaded.games.length, daily.games.length);
  assert.equal(
    reloaded.games[0]?.calibrated.homeWinProbability,
    daily.games[0]?.calibrated.homeWinProbability,
  );
  // The input snapshot must survive, or backtesting cannot be fair.
  assert.ok(reloaded.games[0]?.context.teams.home.offense);
  assert.deepEqual(await store.predictionDates(), [SYNTHETIC_DATE]);
});

test("the loop closes: predict, score, analyse", async () => {
  const preview = await setup();
  const store = new Store(preview.dataDir);
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config: preview.config,
    calibration: DEFAULT_CALIBRATION,
  });
  await store.savePredictions(daily);

  // A second fixture set where the same games are final.
  const final = await setup({ final: true });
  const sources = createSources(final.config);
  const results = await sources.schedule.results(SYNTHETIC_DATE);
  assert.equal(results.length, 2, "both games should report finals");

  const extras = results.find((r) => r.gamePk === EVEN_GAME);
  assert.equal(extras?.wentToExtras, true, "game 2 went 10 innings");
  assert.equal(extras?.homeScore, 3);
  assert.equal(extras?.awayScore, 4);

  const graded = gradeDay({ predictions: daily, results });
  await store.saveGraded(graded);
  assert.equal(graded.games.length, 2);

  const mismatch = graded.games.find((g) => g.gamePk === MISMATCH_GAME)!;
  assert.equal(mismatch.homeWon, true, "HCH won 7-2");
  assert.equal(mismatch.moneylineCorrect, true, "and we picked them");
  assert.equal(mismatch.actualTotal, 9);
  for (const bet of mismatch.bets) {
    assert.ok(bet.won !== undefined, "every bet must be settled or explicitly null");
  }

  const analysis = analyseGraded(graded.games, SYNTHETIC_DATE, SYNTHETIC_DATE);
  assert.equal(analysis.games, 2);
  assert.equal(analysis.moneyline.accuracy, 0.5, "one right, one wrong");
  assert.equal(analysis.extraInnings.observedRate, 0.5);
  assert.ok(analysis.moneyline.brier !== null);
  assert.ok(
    analysis.warnings.some((w) => w.includes("Only 2 graded games")),
    "two games must not be presented as evidence of anything",
  );

  const reloaded = await store.loadGraded(SYNTHETIC_DATE);
  assert.equal(reloaded?.games.length, 2);
});

test("a missing fixture is a loud failure, never a silent empty slate", async () => {
  const { config } = await setup();
  await assert.rejects(
    () =>
      predictDate({
        // A date with no fixture at all.
        date: "2026-06-01",
        config,
        calibration: DEFAULT_CALIBRATION,
      }),
    /no fixture for/,
  );
});
