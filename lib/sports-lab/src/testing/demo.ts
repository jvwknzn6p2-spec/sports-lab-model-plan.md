/**
 * `pnpm --filter @workspace/sports-lab run demo`
 *
 * Runs the whole loop against the SYNTHETIC fixtures — no network, no API key.
 * Every team, player and score is invented; see syntheticSlate.ts. This exists
 * to show the pipeline working and to make the output format reviewable, not to
 * demonstrate accuracy.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRuntimeConfig } from "../config";
import { analyseGraded } from "../loop/analyze";
import { DEFAULT_CALIBRATION } from "../loop/calibration";
import { gradeDay } from "../loop/score";
import { createSources } from "../pipeline/collect";
import { predictDate } from "../pipeline/predict";
import { formatAnalysis, formatDailyReport } from "../report/text";
import { Store } from "../store/store";
import { SYNTHETIC_DATE, writeSyntheticFixtures } from "./syntheticSlate";

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sports-lab-demo-"));
  const previewFixtures = path.join(root, "fixtures-preview");
  const finalFixtures = path.join(root, "fixtures-final");
  const dataDir = path.join(root, "data");
  await writeSyntheticFixtures(previewFixtures, { final: false });
  await writeSyntheticFixtures(finalFixtures, { final: true });

  process.stdout.write(
    "NOTE: this demo runs on synthetic fixtures. The teams, players, venues and\n" +
      "scores below are invented. It shows the pipeline and the output format —\n" +
      "it says nothing about real-world accuracy.\n\n",
  );

  const base = {
    offline: true as const,
    dataDir,
    season: 2026,
    simulations: 20000,
    oddsApiKey: "synthetic-key",
    oddsBook: "draftkings",
  };

  // --- predict --------------------------------------------------------------
  const predictConfig = loadRuntimeConfig({ ...base, fixtureDir: previewFixtures });
  const store = new Store(dataDir);
  const daily = await predictDate({
    date: SYNTHETIC_DATE,
    config: predictConfig,
    calibration: DEFAULT_CALIBRATION,
  });
  await store.savePredictions(daily);
  process.stdout.write(`${formatDailyReport(daily)}\n\n`);

  // --- score ----------------------------------------------------------------
  const scoreConfig = loadRuntimeConfig({ ...base, fixtureDir: finalFixtures });
  const results = await createSources(scoreConfig).schedule.results(SYNTHETIC_DATE);
  await store.saveResults(SYNTHETIC_DATE, results);
  const graded = gradeDay({ predictions: daily, results });
  await store.saveGraded(graded);

  process.stdout.write("=".repeat(78));
  process.stdout.write(`\nSCORED (synthetic finals)\n${"=".repeat(78)}\n`);
  for (const game of graded.games) {
    const settled = game.bets.filter((b) => b.positiveEv && !b.push);
    const profit = settled.reduce((sum, b) => sum + b.profitUnits, 0);
    process.stdout.write(
      `  ${game.matchup}: ${game.result.awayScore}-${game.result.homeScore}` +
        `${game.result.wentToExtras ? ` (${game.result.innings} innings)` : ""}  ` +
        `pick ${game.moneylineCorrect ? "WON" : "LOST"}  ` +
        `total predicted ${game.predictedTotal.toFixed(1)} vs actual ${game.actualTotal}  ` +
        `${settled.length} flagged bet(s) ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}u\n`,
    );
  }
  process.stdout.write("\n");

  // --- analyse --------------------------------------------------------------
  process.stdout.write(
    `${formatAnalysis(analyseGraded(graded.games, SYNTHETIC_DATE, SYNTHETIC_DATE))}\n\n`,
  );
  process.stdout.write(`Artifacts written under ${dataDir}\n`);
}

await main();
