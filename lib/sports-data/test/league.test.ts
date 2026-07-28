import { test } from "node:test";
import assert from "node:assert/strict";

import { simulateGame } from "../src/engine/simulate";
import { settle } from "../src/engine/settle";
import {
  DEFAULT_CALIBRATION,
  type GamePrediction,
} from "../src/engine/decision";

const NOW = new Date("2024-07-26T12:00:00Z");

/**
 * MLB and NPB share every calculation. The single modelled difference is that
 * MLB plays on until someone wins while NPB can end level — so a tie is a real
 * outcome there, and a real outcome that is neither a win nor a loss.
 */

test("MLB never ties; NPB does", () => {
  const mlb = simulateGame(4.5, 4.5, {
    sims: 20_000,
    seed: "lg",
    league: "MLB",
  });
  const npb = simulateGame(4.5, 4.5, {
    sims: 20_000,
    seed: "lg",
    league: "NPB",
  });
  assert.equal(mlb.pTie, 0, "extra innings always decide an MLB game");
  assert.ok(
    npb.pTie > 0.05,
    `evenly matched NPB sides tie often, got ${npb.pTie}`,
  );
});

test("an NPB tie is a moneyline push, not an away win", () => {
  // Equal expected runs: the simulator itself applies no home edge (that lives
  // in the run model), so this is a true coin flip once ties are set aside.
  const even = simulateGame(4.5, 4.5, {
    sims: 20_000,
    seed: "lg",
    league: "NPB",
  });
  // Quoted over decided games only, so the two sides still sum to 1 — the ties
  // sit outside the quote rather than inflating the away side, which is what
  // the old `1 - homeWins/sims` did.
  assert.ok(Math.abs(even.pHomeWin + even.pAwayWin - 1) < 1e-9);
  assert.ok(
    Math.abs(even.pHomeWin - 0.5) < 0.02,
    `even sides should be ~50%, got ${even.pHomeWin}`,
  );

  // A genuine edge still comes through undiluted by the ties.
  const edge = simulateGame(5.2, 4.0, {
    sims: 20_000,
    seed: "lg",
    league: "NPB",
  });
  assert.ok(
    edge.pHomeWin > 0.58,
    `favourite should lead, got ${edge.pHomeWin}`,
  );
});

test("NPB extra innings are configurable without changing anything else", () => {
  const none = simulateGame(4.5, 4.5, {
    sims: 10_000,
    seed: "x",
    league: "NPB",
  });
  const twelve = simulateGame(4.5, 4.5, {
    sims: 10_000,
    seed: "x",
    league: "NPB",
    maxExtraInnings: 3, // the current 12-inning limit
  });
  assert.ok(twelve.pTie > 0, "a 12-inning cap still allows ties");
  assert.ok(twelve.pTie < none.pTie, "playing extras resolves some of them");
});

test("the handicap grid behaves identically in both leagues", () => {
  const npb = simulateGame(4.8, 4.2, {
    sims: 20_000,
    seed: "h",
    league: "NPB",
  });
  // A level line pushes exactly on the ties; half lines still cannot push.
  assert.ok(Math.abs(npb.asianCover("home", 0).push - npb.pTie) < 1e-9);
  assert.equal(npb.asianCover("home", -0.5).push, 0);
  // Monotonicity across the grid is a property of the settlement rule, not the
  // league, so it must hold here too.
  const lines = [0, -0.5, -1, -1.5];
  for (let i = 1; i < lines.length; i++) {
    assert.ok(
      npb.asianCover("home", lines[i]!).probability <=
        npb.asianCover("home", lines[i - 1]!).probability,
    );
  }
});

function pred(): GamePrediction {
  return {
    gamePk: 1,
    gameDate: null,
    home: "Giants",
    away: "Tigers",
    pass: false,
    predictedWinner: "Giants",
    predictedLoser: "Tigers",
    winProbability: 0.58,
    rawWinProbability: 0.6,
    confidence: "B",
    handicap: {
      input: { side: "home", line: 0 },
      pick: "Giants 0",
      coverProbability: 0.58,
    },
    total: { line: null, predicted: 8, pick: null, probability: null },
    expectedRuns: { home: 4.6, away: 4.1 },
    reasons: [],
    flags: [],
  };
}

test("settling a tied NPB game records a push, never an away win", () => {
  const report = settle(
    "2024-07-25",
    [pred()],
    { "1": { homeScore: 4, awayScore: 4 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  const g = report.games[0]!;
  assert.equal(g.actualWinner, null, "nobody won");
  assert.equal(g.winnerCorrect, null, "unscored");
  assert.equal(report.winnerRecord.wins, 0);
  assert.equal(report.winnerRecord.losses, 0);
  // A level handicap pushes on a tie as well.
  assert.equal(g.handicapCorrect, null);
  // Nothing about a returned stake should teach the calibrator anything.
  assert.equal(report.calibrationAfter.shrink, DEFAULT_CALIBRATION.shrink);
  assert.equal(
    report.calibrationAfter.handicapShrink,
    DEFAULT_CALIBRATION.handicapShrink,
  );
});

test("a decided NPB game still scores normally", () => {
  const win = settle(
    "2024-07-25",
    [pred()],
    { "1": { homeScore: 5, awayScore: 4 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(win.games[0]!.actualWinner, "Giants");
  assert.equal(win.games[0]!.winnerCorrect, true);

  const loss = settle(
    "2024-07-25",
    [pred()],
    { "1": { homeScore: 3, awayScore: 4 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(loss.games[0]!.actualWinner, "Tigers");
  assert.equal(loss.games[0]!.winnerCorrect, false);
});
