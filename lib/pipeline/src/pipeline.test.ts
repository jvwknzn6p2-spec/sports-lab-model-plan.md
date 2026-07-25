import { test } from "node:test";
import assert from "node:assert/strict";

import { HeuristicReviewProvider } from "@workspace/ai-review";
import type { GamePrediction } from "@workspace/ai-review";
import { lockPredictions, verifyLock } from "./lock.js";
import { settle } from "./settlement.js";
import type { EnginePredictionsFile, ResultsFile } from "./types.js";

const NOW = new Date("2026-07-25T18:00:00Z");
const provider = new HeuristicReviewProvider();

/** A clean, confirmed, home-favored prediction (engine-shaped). */
function cleanPrediction(): GamePrediction {
  return {
    gameId: "2026-07-25-LAA-HOU",
    startTimeLocal: "7:10 PM",
    home: { abbreviation: "HOU", name: "Astros" },
    away: { abbreviation: "LAA", name: "Angels" },
    data: {
      scheduleConfirmed: true,
      homePitcher: { name: "Valdez", confirmed: true, era: 2.9, whip: 1.05, kPer9: 9.4, inningsPitched: 130 },
      awayPitcher: { name: "Detmers", confirmed: true, era: 4.3, whip: 1.31, kPer9: 8.7, inningsPitched: 110 },
      battingStatsAvailable: true,
      bullpenStatsAvailable: true,
      recentFormAvailable: true,
      injuries: [],
      weather: { tempF: 88, windMph: 12, windDir: "out", precipitationChance: 0.05 },
      parkFactorsAvailable: true,
      oddsAvailable: true,
      fetchedAt: "2026-07-25T16:30:00Z",
      staleAfterMinutes: 240,
    },
    model: {
      moneyline: { homeWinProb: 0.66, awayWinProb: 0.34 },
      runLine: { favoriteCoversProb: 0.41, underdogCoversProb: 0.59 },
      total: { predictedTotal: 8.7, line: 8.5, overProb: 0.54, underProb: 0.46 },
      ev: {
        bets: [
          { market: "moneyline", selection: "HOU ML", edge: 0.06, evPer1Unit: 0.1, positive: true },
        ],
      },
      componentAgreement: 0.82,
      marketEdge: 0.06,
    },
    confidence: "A",
  };
}

/** Unconfirmed starter + stale → the review must force this down to C. */
function dataGapPrediction(): GamePrediction {
  const p = cleanPrediction();
  p.gameId = "2026-07-25-NYY-BOS";
  p.home = { abbreviation: "BOS", name: "Red Sox" };
  p.away = { abbreviation: "NYY", name: "Yankees" };
  p.data.homePitcher = { name: "Bello", confirmed: false, era: 3.8, whip: 1.25, kPer9: 8.1, inningsPitched: 95 };
  p.data.bullpenStatsAvailable = false;
  p.data.fetchedAt = "2026-07-25T09:00:00Z";
  p.model.moneyline = { homeWinProb: 0.57, awayWinProb: 0.43 };
  p.confidence = "S";
  return p;
}

function engineFile(): EnginePredictionsFile {
  return {
    date: "2026-07-25",
    generatedBy: "test",
    gbmTrained: true,
    predictions: [cleanPrediction(), dataGapPrediction()],
  };
}

test("lock runs review, freezes post-review confidence, and hashes", async () => {
  const lf = await lockPredictions(engineFile(), { provider, now: NOW });
  assert.equal(lf.locked.length, 2);

  const clean = lf.locked.find((l) => l.gameId.endsWith("HOU"))!;
  assert.equal(clean.review.finalConfidence, "A"); // survives
  assert.equal(clean.picks.moneyline, "home");

  const gap = lf.locked.find((l) => l.gameId.endsWith("BOS"))!;
  assert.equal(gap.review.finalConfidence, "C"); // downgraded by the auditor
  assert.equal(gap.review.downgraded, true);

  for (const l of lf.locked) assert.ok(verifyLock(l), "hash should verify");
});

test("verifyLock detects tampering", async () => {
  const lf = await lockPredictions(engineFile(), { provider, now: NOW });
  const rec = structuredClone(lf.locked[0]!);
  rec.review.finalConfidence = "S"; // tamper
  assert.equal(verifyLock(rec), false);
});

test("settlement grades moneyline, total, and bet profit", async () => {
  const lf = await lockPredictions(engineFile(), { provider, now: NOW });
  const results: ResultsFile = {
    date: "2026-07-25",
    results: [
      { gameId: "2026-07-25-LAA-HOU", homeScore: 6, awayScore: 3 }, // home win, total 9 → over
      { gameId: "2026-07-25-NYY-BOS", homeScore: 2, awayScore: 5 }, // away win, total 7 → under
    ],
  };
  const settled = settle(lf, results);
  assert.equal(settled.settled.length, 2);

  const hou = settled.settled.find((s) => s.gameId.endsWith("HOU"))!;
  assert.equal(hou.actualHomeWin, true);
  assert.equal(hou.moneylinePick, "home");
  assert.equal(hou.moneylineCorrect, true); // picked home, home won
  assert.equal(hou.totalPick, "over");
  assert.equal(hou.totalCorrect, true); // 9 > 8.5
  const mlBet = hou.evBets.find((b) => b.selection === "HOU ML")!;
  assert.ok(mlBet.profit > 0, "winning ML bet should profit");

  const bos = settled.settled.find((s) => s.gameId.endsWith("BOS"))!;
  assert.equal(bos.actualHomeWin, false);
  assert.equal(bos.moneylinePick, "home");
  assert.equal(bos.moneylineCorrect, false); // picked home, away won
});

test("settlement skips games without a result", async () => {
  const lf = await lockPredictions(engineFile(), { provider, now: NOW });
  const results: ResultsFile = {
    date: "2026-07-25",
    results: [{ gameId: "2026-07-25-LAA-HOU", homeScore: 6, awayScore: 3 }],
  };
  const settled = settle(lf, results);
  assert.equal(settled.settled.length, 1);
});
