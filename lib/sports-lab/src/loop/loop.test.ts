import assert from "node:assert/strict";
import test from "node:test";
import type {
  BetEvaluation,
  DailyPredictions,
  GamePrediction,
  GameResult,
  GradedGame,
  TeamRef,
} from "../core/types";
import { analyseGraded } from "./analyze";
import { dispersionFromMoments, fitCalibration, MIN_GAMES_TO_FIT } from "./calibrate";
import { DEFAULT_CALIBRATION, calibrateTotal, calibrateWinProbability, shrinkTowardDefault } from "./calibration";
import { gradeDay } from "./score";

const HOME: TeamRef = { id: 1, name: "Home Team", abbrev: "HOM" };
const AWAY: TeamRef = { id: 2, name: "Away Team", abbrev: "AWY" };

function bet(overrides: Partial<BetEvaluation> & Pick<BetEvaluation, "grading">): BetEvaluation {
  return {
    market: "moneyline",
    selection: "TEST",
    americanOdds: 100,
    decimalOdds: 2,
    modelProbability: 0.55,
    fairProbability: 0.5,
    edge: 0.05,
    expectedValue: 0.1,
    kellyFraction: 0.02,
    positiveEv: true,
    ...overrides,
  };
}

function prediction(overrides: Partial<GamePrediction> = {}): GamePrediction {
  return {
    sport: "MLB",
    gamePk: 1,
    date: "2026-07-24",
    gameTimeUtc: "2026-07-24T23:10:00Z",
    matchup: "Away Team @ Home Team",
    home: HOME,
    away: AWAY,
    quality: { completeness: 1, missing: [], errorCount: 0, warnCount: 0, usable: true },
    baseline: {
      teams: {
        home: { expectedRuns: 4.6, leagueBaseline: 4.4, adjustments: [], opposingStarterInningsShare: 0.6 },
        away: { expectedRuns: 4.2, leagueBaseline: 4.4, adjustments: [], opposingStarterInningsShare: 0.6 },
      },
      expectedTotal: 8.8,
      expectedMargin: 0.4,
    },
    simulation: {
      simulations: 20000,
      seed: "test",
      winProbability: { home: 0.55, away: 0.45 },
      homeCoversMinus1p5: 0.4,
      awayCoversPlus1p5: 0.6,
      meanTotal: 8.8,
      meanMargin: 0.4,
      extraInningsRate: 0.087,
      winProbStdError: 0.0035,
      totalDistribution: { line: 8.5, over: 0.52, under: 0.48, push: 0 },
      percentiles: { total: { p10: 5, p50: 9, p90: 13 }, margin: { p10: -4, p50: 1, p90: 5 } },
      marginHistogram: { min: 0, counts: [], total: 0 },
      totalHistogram: { min: 0, counts: [], total: 0 },
    },
    calibrated: {
      homeWinProbability: 0.55,
      awayWinProbability: 0.45,
      predictedTotal: 8.8,
      calibrationVersion: "test",
    },
    moneylinePick: { side: "home", team: HOME, probability: 0.55 },
    bets: [],
    confidence: {
      rank: "A",
      score: 60,
      components: { edgeScore: 50, dataScore: 100, agreementScore: 90, precisionScore: 90 },
      caps: [],
      notes: [],
    },
    keyFactors: [],
    issues: [],
    context: {} as GamePrediction["context"],
    modelVersion: "test",
    predictedAt: "2026-07-24T12:00:00Z",
    ...overrides,
  };
}

function result(homeScore: number, awayScore: number, innings = 9): GameResult {
  return {
    sport: "MLB",
    gamePk: 1,
    date: "2026-07-24",
    status: "Final",
    homeScore,
    awayScore,
    innings,
    wentToExtras: innings > 9,
    fetchedAt: "2026-07-25T04:00:00Z",
  };
}

function daily(games: GamePrediction[]): DailyPredictions {
  return {
    sport: "MLB",
    date: "2026-07-24",
    generatedAt: "2026-07-24T12:00:00Z",
    modelVersion: "test",
    calibrationVersion: "test",
    games,
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

test("moneyline bets settle on the winner", () => {
  const graded = gradeDay({
    predictions: daily([
      prediction({
        bets: [
          bet({ grading: { kind: "moneyline", side: "home" } }),
          bet({ grading: { kind: "moneyline", side: "away" } }),
        ],
      }),
    ]),
    results: [result(5, 3)],
  });
  const [game] = graded.games as [GradedGame];
  assert.equal(game.homeWon, true);
  assert.equal(game.moneylineCorrect, true);
  assert.equal(game.bets[0]?.won, true);
  assert.equal(game.bets[0]?.profitUnits, 1); // +100 pays 1 unit
  assert.equal(game.bets[1]?.won, false);
  assert.equal(game.bets[1]?.profitUnits, -1);
});

test("a losing pick is recorded as a loss, not quietly dropped", () => {
  const graded = gradeDay({
    predictions: daily([prediction()]),
    results: [result(2, 6)],
  });
  assert.equal(graded.games[0]?.moneylineCorrect, false);
});

test("the run line settles against the handicap", () => {
  const graded = gradeDay({
    predictions: daily([
      prediction({
        bets: [
          bet({ market: "runline", grading: { kind: "runline", side: "home", homeHandicap: -1.5 } }),
          bet({ market: "runline", grading: { kind: "runline", side: "away", homeHandicap: -1.5 } }),
        ],
      }),
    ]),
    // Home wins by exactly 1: -1.5 loses, +1.5 wins.
    results: [result(4, 3)],
  });
  assert.equal(graded.games[0]?.bets[0]?.won, false);
  assert.equal(graded.games[0]?.bets[1]?.won, true);
});

test("an integer handicap can push, and a push costs nothing", () => {
  const graded = gradeDay({
    predictions: daily([
      prediction({
        bets: [
          bet({ market: "runline", grading: { kind: "runline", side: "home", homeHandicap: -2 } }),
        ],
      }),
    ]),
    results: [result(5, 3)], // exactly 2, so -2 pushes
  });
  assert.equal(graded.games[0]?.bets[0]?.push, true);
  assert.equal(graded.games[0]?.bets[0]?.won, null);
  assert.equal(graded.games[0]?.bets[0]?.profitUnits, 0);
});

test("totals settle over, under, and push correctly", () => {
  const bets = [
    bet({ market: "total", grading: { kind: "total", direction: "over", line: 8.5 } }),
    bet({ market: "total", grading: { kind: "total", direction: "under", line: 8.5 } }),
    bet({ market: "total", grading: { kind: "total", direction: "over", line: 9 } }),
  ];
  const graded = gradeDay({
    predictions: daily([prediction({ bets })]),
    results: [result(5, 4)], // total 9
  });
  assert.equal(graded.games[0]?.bets[0]?.won, true, "over 8.5 wins on 9");
  assert.equal(graded.games[0]?.bets[1]?.won, false, "under 8.5 loses on 9");
  assert.equal(graded.games[0]?.bets[2]?.push, true, "over 9 pushes on 9");
});

test("profit uses the actual price, not a flat assumption", () => {
  const graded = gradeDay({
    predictions: daily([
      prediction({
        bets: [
          bet({ americanOdds: 150, decimalOdds: 2.5, grading: { kind: "moneyline", side: "home" } }),
        ],
      }),
    ]),
    results: [result(5, 3)],
  });
  assert.equal(graded.games[0]?.bets[0]?.profitUnits, 1.5);
});

test("games with no final score are left ungraded rather than guessed", () => {
  const graded = gradeDay({ predictions: daily([prediction()]), results: [] });
  assert.equal(graded.games.length, 0);
});

test("totalError keeps its sign so bias is measurable", () => {
  const graded = gradeDay({
    predictions: daily([prediction()]), // predicted 8.8
    results: [result(3, 2)], // actual 5
  });
  assert.ok(Math.abs((graded.games[0] as GradedGame).totalError - 3.8) < 1e-9);
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function gradedGame(overrides: Partial<GradedGame> = {}): GradedGame {
  return {
    gamePk: 1,
    date: "2026-07-24",
    matchup: "Away Team @ Home Team",
    rank: "B",
    homeWinProbability: 0.55,
    predictedTotal: 8.8,
    simulatedExtraInningsRate: 0.087,
    result: result(5, 3),
    homeWon: true,
    moneylineCorrect: true,
    actualTotal: 8,
    totalError: 0.8,
    bets: [],
    ...overrides,
  };
}

test("an empty range reports nothing rather than dividing by zero", () => {
  const report = analyseGraded([], "2026-07-01", "2026-07-24");
  assert.equal(report.games, 0);
  assert.equal(report.moneyline.accuracy, null);
  assert.equal(report.betting.roi, null);
  assert.ok(report.warnings.some((w) => w.includes("No graded games")));
});

test("small samples are flagged as unusable", () => {
  const report = analyseGraded([gradedGame()], "2026-07-24", "2026-07-24");
  assert.equal(report.games, 1);
  assert.ok(report.warnings.some((w) => w.includes("Only 1 graded games")));
});

test("accuracy, ROI and rank breakdown are computed from the graded rows", () => {
  const games = [
    gradedGame({
      rank: "S",
      moneylineCorrect: true,
      bets: [{ ...bet({ grading: { kind: "moneyline", side: "home" } }), won: true, push: false, profitUnits: 1 }],
    }),
    gradedGame({
      rank: "S",
      moneylineCorrect: false,
      homeWon: false,
      bets: [{ ...bet({ grading: { kind: "moneyline", side: "home" } }), won: false, push: false, profitUnits: -1 }],
    }),
    gradedGame({ rank: "C", moneylineCorrect: true }),
  ];
  const report = analyseGraded(games, "2026-07-01", "2026-07-24");
  assert.ok(Math.abs((report.moneyline.accuracy as number) - 2 / 3) < 1e-9);
  assert.equal(report.betting.unitsStaked, 2);
  assert.equal(report.betting.profitUnits, 0);
  assert.equal(report.betting.roi, 0);

  const sRank = report.byRank.find((r) => r.rank === "S");
  assert.equal(sRank?.games, 2);
  assert.equal(sRank?.moneylineAccuracy, 0.5);
  const cRank = report.byRank.find((r) => r.rank === "C");
  assert.equal(cRank?.games, 1);
});

test("the observed extra-innings rate is measured against the simulated one", () => {
  const games = [
    gradedGame({ result: result(5, 4, 10), simulatedExtraInningsRate: 0.1 }),
    gradedGame({ simulatedExtraInningsRate: 0.08 }),
  ];
  const report = analyseGraded(games, "2026-07-01", "2026-07-24");
  assert.equal(report.extraInnings.observedRate, 0.5);
  assert.ok(Math.abs((report.extraInnings.predictedRate as number) - 0.09) < 1e-9);
});

test("a mis-ordered confidence ladder produces a warning", () => {
  const games = [
    ...Array.from({ length: 25 }, () => gradedGame({ rank: "S", moneylineCorrect: false })),
    ...Array.from({ length: 25 }, () => gradedGame({ rank: "A", moneylineCorrect: true })),
  ];
  const report = analyseGraded(games, "2026-07-01", "2026-07-24");
  assert.ok(
    report.warnings.some((w) => w.includes("out-performing")),
    `expected a rank-order warning, got: ${report.warnings.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

test("calibration transforms are the identity until something is fitted", () => {
  assert.equal(calibrateWinProbability(0.62, DEFAULT_CALIBRATION), 0.62);
  assert.equal(calibrateTotal(9.1, DEFAULT_CALIBRATION), 9.1);
  assert.equal(DEFAULT_CALIBRATION.sampleGames, 0);
});

test("a fitted Platt transform actually moves the probability", () => {
  const calibration = { ...DEFAULT_CALIBRATION, moneyline: { a: 0.8, b: -0.1 } };
  const adjusted = calibrateWinProbability(0.7, calibration);
  assert.ok(adjusted < 0.7, "an overconfident model should be pulled back");
  assert.ok(adjusted > 0.5, "but not flipped");
});

test("a fitted totals bias shifts the predicted total", () => {
  const calibration = { ...DEFAULT_CALIBRATION, totals: { bias: -0.4, scale: 1, pivot: 8.5 } };
  assert.ok(Math.abs(calibrateTotal(9, calibration) - 8.6) < 1e-9);
});

test("shrinkage weights the fit by sample size", () => {
  assert.equal(shrinkTowardDefault(2, 1, 0, 400), 1, "no data means no movement");
  const small = shrinkTowardDefault(2, 1, 40, 400);
  const large = shrinkTowardDefault(2, 1, 4000, 400);
  assert.ok(small > 1 && small < 1.15, `40 games should barely move it: ${small}`);
  assert.ok(large > 1.85, `4000 games should nearly adopt the fit: ${large}`);
});

test("calibration refuses to fit below the minimum sample", () => {
  const games = Array.from({ length: MIN_GAMES_TO_FIT - 1 }, () => gradedGame());
  const fit = fitCalibration(games, DEFAULT_CALIBRATION, "2026-07-01", "2026-07-24");
  assert.equal(fit.changes.length, 0);
  assert.equal(fit.calibration.moneyline.a, 1);
  assert.equal(fit.calibration.sampleGames, 0);
  assert.ok(fit.skipped[0]?.includes(`need ${MIN_GAMES_TO_FIT}`));
});

test("calibration learns a real totals bias but shrinks it", () => {
  // The model says 9.0 every time; reality averages 8.0. Raw bias is -1.0.
  const games = Array.from({ length: 200 }, (_, i) =>
    gradedGame({
      gamePk: i,
      predictedTotal: 9,
      actualTotal: 8,
      totalError: 1,
      result: result(4, 4),
    }),
  );
  const fit = fitCalibration(games, DEFAULT_CALIBRATION, "2026-05-01", "2026-07-24");
  assert.ok(fit.calibration.totals.bias < 0, "should correct downward");
  assert.ok(
    fit.calibration.totals.bias > -1,
    `must be shrunk, not adopted wholesale: ${fit.calibration.totals.bias}`,
  );
  assert.equal(fit.calibration.sampleGames, 200);
  assert.ok(fit.calibration.version.includes("n200"));
  assert.ok(fit.changes.some((c) => c.includes("totals bias")));
});

test("calibration re-estimates the extra-innings rate from what happened", () => {
  // 30% of games went to extras — far above the default.
  const games = Array.from({ length: 300 }, (_, i) =>
    gradedGame({ gamePk: i, result: result(5, 4, i % 10 < 3 ? 10 : 9) }),
  );
  const fit = fitCalibration(games, DEFAULT_CALIBRATION, "2026-05-01", "2026-07-24");
  assert.ok(
    fit.calibration.extraInningsRate > DEFAULT_CALIBRATION.extraInningsRate,
    "should move toward the observed rate",
  );
  assert.ok(fit.calibration.extraInningsRate < 0.3, "but shrunk, not adopted");
});

test("confidence thresholds are never auto-tuned", () => {
  const games = Array.from({ length: 200 }, (_, i) => gradedGame({ gamePk: i }));
  const fit = fitCalibration(games, DEFAULT_CALIBRATION, "2026-05-01", "2026-07-24");
  assert.deepEqual(
    fit.calibration.confidenceThresholds,
    DEFAULT_CALIBRATION.confidenceThresholds,
  );
  assert.ok(fit.skipped.some((s) => s.includes("confidence thresholds")));
});

test("dispersion is recovered from moments, and refused when underdispersed", () => {
  // variance = mu + mu^2/k  =>  k = mu^2 / (variance - mu)
  const k = dispersionFromMoments(4.4, 4.4 + (4.4 * 4.4) / 4.2);
  assert.ok(Math.abs((k as number) - 4.2) < 1e-6, `got ${k}`);
  assert.equal(dispersionFromMoments(4.4, 4.4), null, "Poisson-like data has no finite k");
  assert.equal(dispersionFromMoments(4.4, 2), null, "underdispersed data must be refused");
  assert.equal(dispersionFromMoments(0, 5), null);
});
