import { test } from "node:test";
import assert from "node:assert/strict";

import { simulateGame } from "../src/engine/simulate";
import { settle } from "../src/engine/settle";
import {
  DEFAULT_CALIBRATION,
  type GamePrediction,
} from "../src/engine/decision";

const NOW = new Date("2024-07-26T12:00:00Z");
const SIM = simulateGame(4.8, 4.2, { sims: 20_000, seed: "asian" });

test("a whole-number line pushes on the exact margin instead of losing", () => {
  // Home -1.0: a one-run home win returns the stake. It must appear in `push`,
  // and must NOT drag the quoted probability down as a loss would.
  const c = SIM.asianCover("home", -1);
  assert.ok(c.push > 0, "a one-run margin has to produce pushes");
  assert.ok(Math.abs(c.win + c.push + c.loss - 1) < 1e-9, "shares sum to 1");
  assert.ok(
    Math.abs(c.probability - c.win / (c.win + c.loss)) < 1e-9,
    "quote excludes pushes",
  );
  // Scoring pushes as losses (the old behaviour) understates the line.
  assert.ok(
    c.probability > c.win,
    "push-excluded quote beats the raw win share",
  );
});

test("a half line can never push", () => {
  for (const line of [-1.5, -0.5, 0.5, 1.5]) {
    const c = SIM.asianCover("home", line);
    assert.equal(c.push, 0, `line ${line} must not push`);
  }
});

test("a zero line is the moneyline (baseball has no ties)", () => {
  const c = SIM.asianCover("home", 0);
  assert.equal(c.push, 0, "extra innings mean no tie survives to settlement");
  assert.ok(
    Math.abs(c.probability - SIM.pHomeWin) < 1e-9,
    "level handicap == win probability",
  );
});

test("a quarter line splits the stake across its two neighbours", () => {
  // -0.75 is half a stake at -0.5 and half at -1.0. Its settlement shares must
  // be the average of those two lines', not a third independent number.
  const q = SIM.asianCover("home", -0.75);
  const half = SIM.asianCover("home", -0.5);
  const whole = SIM.asianCover("home", -1);
  assert.ok(Math.abs(q.win - (half.win + whole.win) / 2) < 1e-9);
  assert.ok(Math.abs(q.push - (half.push + whole.push) / 2) < 1e-9);
  assert.ok(Math.abs(q.loss - (half.loss + whole.loss) / 2) < 1e-9);
  // Half the stake sits on the whole line, so half of its pushes survive.
  assert.ok(q.push > 0 && q.push < whole.push);
});

test("giving a bigger handicap is always harder", () => {
  const lines = [0, -0.25, -0.5, -0.75, -1, -1.25, -1.5];
  for (let i = 1; i < lines.length; i++) {
    assert.ok(
      SIM.asianCover("home", lines[i]!).probability <=
        SIM.asianCover("home", lines[i - 1]!).probability,
      `line ${lines[i]} must not be easier than ${lines[i - 1]}`,
    );
  }
});

function pred(
  line: number,
  side: "home" | "away",
  pick: string,
): GamePrediction {
  return {
    gamePk: 1,
    gameDate: null,
    home: "Guardians",
    away: "Tigers",
    pass: false,
    predictedWinner: "Guardians",
    predictedLoser: "Tigers",
    winProbability: 0.58,
    rawWinProbability: 0.6,
    confidence: "B",
    handicap: {
      input: { side, line },
      pick,
      coverProbability: 0.55,
      rawCoverProbability: 0.56,
      ev: 0.05,
      noValue: false,
    },
    total: {
      line: null,
      predicted: 8,
      pick: null,
      probability: null,
      rawProbability: null,
    },
    expectedRuns: { home: 4.6, away: 4.1 },
    reasons: [],
    flags: [],
  };
}

test("settlement treats an exact-margin whole line as a push, not a loss", () => {
  // Guardians -1.0 win by exactly 1 → stake returned.
  const report = settle(
    "2024-07-25",
    [pred(-1, "home", "Guardians -1")],
    { "1": { homeScore: 4, awayScore: 3 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  const g = report.games[0]!;
  assert.equal(g.handicapCorrect, null, "push is unscored");
  assert.equal(report.handicapRecord.wins, 0);
  assert.equal(report.handicapRecord.losses, 0);
  // A push must not move the handicap calibration either.
  assert.equal(
    report.calibrationAfter.handicapShrink,
    DEFAULT_CALIBRATION.handicapShrink,
  );
});

test("settlement still scores a clear handicap win and loss", () => {
  const win = settle(
    "2024-07-25",
    [pred(-1, "home", "Guardians -1")],
    { "1": { homeScore: 6, awayScore: 3 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(win.games[0]!.handicapCorrect, true);

  const loss = settle(
    "2024-07-25",
    [pred(-1, "home", "Guardians -1")],
    { "1": { homeScore: 3, awayScore: 6 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(loss.games[0]!.handicapCorrect, false);
});

test("taking the other side of the quoted line settles from that side", () => {
  // Line is quoted on home (-1) but the pick took the away side (+1).
  // Away losing by exactly 1 is a push for the away backer too.
  const push = settle(
    "2024-07-25",
    [pred(-1, "home", "Tigers +1")],
    { "1": { homeScore: 4, awayScore: 3 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(push.games[0]!.handicapCorrect, null);

  // Away losing by 2 → the +1 backer loses.
  const lose = settle(
    "2024-07-25",
    [pred(-1, "home", "Tigers +1")],
    { "1": { homeScore: 5, awayScore: 3 } },
    DEFAULT_CALIBRATION,
    NOW,
  );
  assert.equal(lose.games[0]!.handicapCorrect, false);
});
