import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleDate } from "../src/step2";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../src/sources/fixture-source";
import { expectedRuns } from "../src/engine/run-model";
import { simulateGame } from "../src/engine/simulate";
import {
  calibrate,
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
} from "../src/engine/decision";
import { settle, updateCalibration } from "../src/engine/settle";
import { mulberry32, poisson } from "../src/engine/rng";

const here = dirname(fileURLToPath(import.meta.url));

async function loadSlateGames() {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const source = new FixtureCoreDataSource(bundle);
  return assembleDate(bundle.date, source, { season: bundle.season });
}

test("poisson sampler has roughly the right mean", () => {
  const rng = mulberry32(42);
  let sum = 0;
  const n = 20_000;
  for (let i = 0; i < n; i++) sum += poisson(4.5, rng);
  assert.ok(Math.abs(sum / n - 4.5) < 0.1, `mean=${sum / n}`);
});

test("simulation is deterministic under the same seed", () => {
  const a = simulateGame(4.6, 4.1, { sims: 5000, seed: "2024-07-25:1" });
  const b = simulateGame(4.6, 4.1, { sims: 5000, seed: "2024-07-25:1" });
  const c = simulateGame(4.6, 4.1, { sims: 5000, seed: "2024-07-25:2" });
  assert.equal(a.pHomeWin, b.pHomeWin);
  assert.equal(a.meanTotal, b.meanTotal);
  assert.notEqual(a.pHomeWin, c.pHomeWin);
});

test("higher expected runs → higher win probability, probabilities coherent", () => {
  const sim = simulateGame(5.2, 3.8, { sims: 20_000, seed: 7 });
  assert.ok(sim.pHomeWin > 0.6, `pHome=${sim.pHomeWin}`);
  assert.ok(Math.abs(sim.pHomeWin + sim.pAwayWin - 1) < 1e-9);
  // Favorite covers -1.5 less often than it wins outright.
  assert.ok(sim.pHomeCoverMinus15 < sim.pHomeWin);
  const t = sim.totalProb(8.5);
  assert.ok(Math.abs(t.over + t.under - 1) < 1e-9);
});

test("run model favors the stronger side and applies home advantage", async () => {
  const games = await loadSlateGames();
  const detCle = games.find((g) => g.gamePk === 745804)!;
  const runs = expectedRuns(detCle, 2024);
  // Skubal (away) is far better than Bibee → CLE expected runs suppressed.
  assert.ok(runs.homeMu < runs.awayMu + 1, "sanity: both sides in range");
  assert.ok(runs.homeMu >= 2 && runs.homeMu <= 8.5);
  assert.ok(runs.awayMu >= 2 && runs.awayMu <= 8.5);
});

test("calibration shrinks the edge toward 50%", () => {
  const p = calibrate(0.7, 0.85);
  assert.ok(Math.abs(p - 0.67) < 0.001, `p=${p}`);
  assert.equal(calibrate(0.5, DEFAULT_CALIBRATION.shrink), 0.5);
});

test("decision engine picks a winner with reasons, PASSes near coin-flips", async () => {
  const games = await loadSlateGames();
  const g = games[0]!;
  const runs = expectedRuns(g, 2024);

  const strong = simulateGame(5.5, 3.6, { sims: 10_000, seed: 1 });
  const pick = decide(g, runs, strong, DEFAULT_CALIBRATION, {
    side: "home",
    line: -1.5,
    total: 8.5,
  });
  assert.equal(pick.pass, false);
  assert.ok(pick.predictedWinner && pick.predictedLoser);
  assert.notEqual(pick.predictedWinner, pick.predictedLoser);
  assert.ok(pick.winProbability >= 0.55);
  assert.ok(pick.handicap.pick !== null);
  assert.ok(pick.total.pick !== null);
  assert.ok(pick.reasons.length > 0);

  const coinflip = simulateGame(4.3, 4.3, { sims: 10_000, seed: 2 });
  const pass = decide(g, runs, coinflip, DEFAULT_CALIBRATION, null);
  assert.equal(pass.pass, true);
  assert.equal(pass.predictedWinner, null);
  assert.ok(pass.reasons[0]!.startsWith("PASS:"));
});

test("incomplete game data forces PASS and confidence C", async () => {
  const games = await loadSlateGames();
  const g = { ...games[0]!, complete: false };
  const runs = expectedRuns(g, 2024);
  const sim = simulateGame(5.5, 3.6, { sims: 5000, seed: 3 });
  const p = decide(g, runs, sim, DEFAULT_CALIBRATION, null);
  assert.equal(p.pass, true);
  assert.equal(p.confidence, "C");
});

test("settlement scores picks and self-learning moves shrink the right way", async () => {
  const games = await loadSlateGames();
  const runs0 = expectedRuns(games[0]!, 2024);
  const runs1 = expectedRuns(games[1]!, 2024);
  const preds = [
    decide(
      games[0]!,
      runs0,
      simulateGame(5.4, 3.7, { sims: 5000, seed: 4 }),
      DEFAULT_CALIBRATION,
      {
        side: "home",
        line: -1.5,
        total: 8.5,
      },
    ),
    decide(
      games[1]!,
      runs1,
      simulateGame(5.4, 3.7, { sims: 5000, seed: 5 }),
      DEFAULT_CALIBRATION,
      null,
    ),
  ];
  assert.ok(preds.every((p) => !p.pass));

  // Both picks are the HOME team (higher mu). Feed one win, one loss.
  const now = new Date("2024-07-26T12:00:00Z");
  const report = settle(
    "2024-07-25",
    preds,
    {
      [String(preds[0]!.gamePk)]: { homeScore: 6, awayScore: 2 },
      [String(preds[1]!.gamePk)]: { homeScore: 1, awayScore: 4 },
    },
    DEFAULT_CALIBRATION,
    now,
  );
  assert.equal(report.gamesSettled, 2);
  assert.equal(report.winnerRecord.wins, 1);
  assert.equal(report.winnerRecord.losses, 1);
  assert.ok(report.meanBrier !== null && report.meanBrier > 0);
  // Stated ~66%, actual 50% → overconfident → shrink must go DOWN.
  assert.ok(report.calibrationAfter.shrink < report.calibrationBefore.shrink);
  assert.equal(report.calibrationAfter.gamesSettled, 2);

  // Underconfidence moves shrink UP (both picks win).
  const up = settle(
    "2024-07-25",
    preds,
    {
      [String(preds[0]!.gamePk)]: { homeScore: 6, awayScore: 2 },
      [String(preds[1]!.gamePk)]: { homeScore: 4, awayScore: 1 },
    },
    DEFAULT_CALIBRATION,
    now,
  );
  assert.ok(up.calibrationAfter.shrink > DEFAULT_CALIBRATION.shrink);
});

test("PASS games are excluded from settlement scoring", async () => {
  const games = await loadSlateGames();
  const runs = expectedRuns(games[0]!, 2024);
  const passPred = decide(
    games[0]!,
    runs,
    simulateGame(4.3, 4.3, { sims: 5000, seed: 6 }),
    DEFAULT_CALIBRATION,
    null,
  );
  assert.equal(passPred.pass, true);
  const report = settle(
    "2024-07-25",
    [passPred],
    { [String(passPred.gamePk)]: { homeScore: 3, awayScore: 2 } },
    DEFAULT_CALIBRATION,
    new Date("2024-07-26T12:00:00Z"),
  );
  assert.equal(report.gamesSettled, 0);
  assert.equal(report.gamesPassed, 1);
  // No scored games → calibration untouched.
  assert.equal(report.calibrationAfter.shrink, DEFAULT_CALIBRATION.shrink);
});

test("updateCalibration is bounded and damped", () => {
  const one = [
    {
      gamePk: 1,
      home: "H",
      away: "A",
      pass: false,
      predictedWinner: "H",
      actualWinner: "A",
      winnerCorrect: false,
      statedProbability: 0.99,
      brier: 0.98,
      handicapPick: null,
      handicapCorrect: null,
      handicapProbability: null,
      totalPick: null,
      totalCorrect: null,
      totalProbability: null,
      marginError: 1,
      totalError: 1,
    },
  ];
  const s = updateCalibration(
    { ...DEFAULT_CALIBRATION },
    one,
    new Date("2024-07-26T00:00:00Z"),
  );
  // One catastrophic game moves shrink only slightly (damping 1/21).
  assert.ok(s.shrink > 0.8 && s.shrink < DEFAULT_CALIBRATION.shrink);
});
