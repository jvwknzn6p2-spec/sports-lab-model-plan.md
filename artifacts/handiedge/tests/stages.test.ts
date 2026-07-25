import { test } from "node:test";
import assert from "node:assert/strict";

import { runIntake } from "../src/stages/intake.js";
import { buildFeatures, windSigned } from "../src/stages/features.js";
import { runPrediction } from "../src/stages/prediction.js";
import { decide } from "../src/stages/decision.js";
import { settle } from "../src/stages/settlement.js";
import { analyze } from "../src/stages/errorAnalysis.js";
import { selfLearn } from "../src/stages/selfLearning.js";
import {
  controlTowerSchema,
  scheduleSchema,
  handicapSchema,
  type LockedFile,
  type Results,
  type SettledFile,
  type ErrorReport,
} from "../src/schemas.js";

const CTRL = controlTowerSchema.parse({});

function schedule() {
  return scheduleSchema.parse({
    date: "2026-07-25",
    games: [
      {
        gameId: "G1",
        startTimeLocal: "7:10 PM",
        home: { abbreviation: "HOU", name: "Astros" },
        away: { abbreviation: "LAA", name: "Angels" },
        homePitcher: { name: "Ace", confirmed: true, era: 2.6, whip: 1.0, kPer9: 10, inningsPitched: 130 },
        awayPitcher: { name: "Mid", confirmed: true, era: 4.8, whip: 1.4, kPer9: 7, inningsPitched: 100 },
        homeBatRunsPg: 5.1, awayBatRunsPg: 3.9,
        homeBullpenEra: 3.1, awayBullpenEra: 4.7,
        homeFormL10: 0.6, awayFormL10: 0.4,
        parkFactor: 1.0, tempF: 80, windMph: 10, windDir: "out",
        battingStatsAvailable: true, bullpenStatsAvailable: true, oddsAvailable: true,
        fetchedAt: "2026-07-25T16:30:00Z",
      },
    ],
  });
}

test("intake flags unconfirmed starter as incomplete", () => {
  const s = schedule();
  s.games[0]!.homePitcher!.confirmed = false;
  const h = handicapSchema.parse({ date: "2026-07-25", lines: [{ gameId: "G1", favorite: "home", handicap: -1.5 }] });
  const [game] = runIntake(s, h);
  assert.equal(game!.dataComplete, false);
  assert.ok(game!.dataIssues.some((i) => i.includes("home starter")));
});

test("features assemble the full vector and sign the wind", () => {
  const h = handicapSchema.parse({ date: "2026-07-25", lines: [{ gameId: "G1", favorite: "home", handicap: -1.5 }] });
  const [game] = runIntake(schedule(), h);
  const row = buildFeatures(game!);
  assert.equal(row.features.wind_signed, 10);
  assert.equal(row.features.home_starter_era, 2.6);
  assert.equal(windSigned("in", 8), -8);
});

test("decision picks the strong home team and finds a handicap edge", () => {
  const h = handicapSchema.parse({ date: "2026-07-25", lines: [{ gameId: "G1", favorite: "home", handicap: -1.5 }] });
  const [game] = runIntake(schedule(), h);
  const pred = runPrediction(buildFeatures(game!), { winModel: null, weights: { logistic: 0.6, baseline: 0.4 } });
  const dec = decide(game!, pred, CTRL);
  assert.equal(dec.winner, "HOU");
  assert.equal(dec.loser, "LAA");
  assert.equal(dec.play, true);
});

test("decision PASSes a coin-flip game", () => {
  const h = handicapSchema.parse({ date: "2026-07-25", lines: [{ gameId: "G1", favorite: "home", handicap: -1.5 }] });
  const [game] = runIntake(schedule(), h);
  // Force a near-50/50 prediction.
  const dec = decide(game!, {
    gameId: "G1", homeWinProbRaw: 0.51, logisticP: 0.51, baselineP: 0.51,
    coversProbRaw: 0.31, predictedTotal: 8.5, componentAgreement: 0.9,
  }, CTRL);
  assert.equal(dec.play, false);
  assert.equal(dec.winner, null);
  assert.ok(dec.passReason);
});

function lockedFile(): LockedFile {
  return {
    date: "2026-07-25", runLabel: "t", lockedAt: "2026-07-25T18:00:00Z", reviewProvider: "heuristic",
    games: [
      {
        gameId: "G1", matchup: "LAA @ HOU", decision: "PLAY", winner: "HOU", loser: "LAA",
        handicapPick: "HOU -1.5", winProbability: 0.66, confidence: "A", reasons: [], passReason: null,
        contentHash: "x", homeAbbr: "HOU", awayAbbr: "LAA", homeWinProbHome: 0.66,
        handicapFavorite: "home", handicapLine: 1.5, handicapSide: "favorite",
      },
    ],
  };
}

test("settlement grades winner and handicap cover", () => {
  const results: Results = { date: "2026-07-25", results: [{ gameId: "G1", homeScore: 6, awayScore: 3 }] };
  const settled = settle(lockedFile(), results);
  const g = settled.settled[0]!;
  assert.equal(g.actualHomeWin, true);
  assert.equal(g.winnerCorrect, true);
  assert.equal(g.handicapCorrect, true); // home won by 3 > 1.5
});

test("settlement marks handicap loss when favorite fails to cover", () => {
  const lf = lockedFile();
  const results: Results = { date: "2026-07-25", results: [{ gameId: "G1", homeScore: 2, awayScore: 1 }] };
  const g = settle(lf, results).settled[0]!;
  assert.equal(g.winnerCorrect, true); // home won
  assert.equal(g.handicapCorrect, false); // won by only 1, doesn't cover -1.5
});

test("error analysis computes accuracy by confidence and pass rate", () => {
  const settled: SettledFile = {
    date: "2026-07-25", runLabel: "t",
    settled: [
      { gameId: "a", decision: "PLAY", confidence: "A", winProbability: 0.7, pickedHome: true, winnerCorrect: true, handicapPick: null, handicapCorrect: null, actualHomeWin: true, homeWinProbForCalibration: 0.7 },
      { gameId: "b", decision: "PASS", confidence: "C", winProbability: 0.52, pickedHome: null, winnerCorrect: null, handicapPick: null, handicapCorrect: null, actualHomeWin: false, homeWinProbForCalibration: 0.52 },
    ],
  };
  const r = analyze(settled);
  assert.equal(r.nGames, 2);
  assert.equal(r.nPlays, 1);
  assert.equal(r.passRate, 0.5);
  assert.equal(r.accuracyByConfidence.A?.accuracy, 1);
});

test("self-learning shifts weight off logistic when over-confident", () => {
  const report: ErrorReport = {
    date: "2026-07-25", runLabel: "t", nGames: 10, nPlays: 8, passRate: 0.2,
    winnerAccuracy: 0.5, handicapAccuracy: 0.5, accuracyByConfidence: {},
    brier: 0.3, calibrationEce: 0.09, overconfidenceSignal: 0.15,
  };
  const update = selfLearn(report, { logistic: 0.6, baseline: 0.4 });
  assert.ok(update.newWeights.logistic < 0.6);
  assert.equal(update.recalibrate, true);
  assert.ok(Math.abs(update.newWeights.logistic + update.newWeights.baseline - 1) < 1e-9);
});
