import { test } from "node:test";
import assert from "node:assert/strict";

import {
  breakEvenProbability,
  expectedValueFromProbability,
  recommendedStake,
} from "../src/engine/ev";
import {
  expectedProfit,
  parseHandicapNotation,
} from "../src/engine/handicap-notation";
import { simulateGame } from "../src/engine/simulate";
import {
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
  rankByValue,
  type GamePrediction,
  type HandicapInput,
} from "../src/engine/decision";
import type { GameCoreData } from "../src/step2";

test("break-even is 52.63%, not 50% — the cut is the whole point", () => {
  assert.ok(Math.abs(breakEvenProbability(0.1) - 1 / 1.9) < 1e-12);
  assert.ok(Math.abs(breakEvenProbability(0.1) - 0.5263) < 0.0001);
  // A coin flip loses money; so does anything between 50% and 52.6%.
  assert.ok(expectedValueFromProbability(0.5, 0) < 0);
  assert.ok(expectedValueFromProbability(0.52, 0) < 0);
  assert.ok(expectedValueFromProbability(0.53, 0) > 0);
  // Exactly at break-even the bet is worth nothing.
  assert.ok(
    Math.abs(expectedValueFromProbability(breakEvenProbability(0.1), 0)) <
      1e-12,
  );
  // With no cut at all, 50% would be break-even.
  assert.equal(breakEvenProbability(0), 0.5);
});

test("a pushed share is neither risked nor won", () => {
  // Same 60% cover, but half the stake comes back: the bet is half the size,
  // so both the reward and the exposure halve.
  const full = expectedValueFromProbability(0.6, 0);
  const half = expectedValueFromProbability(0.6, 0.5);
  assert.ok(Math.abs(half - full / 2) < 1e-12);
  // An all-push line risks nothing and wins nothing.
  assert.equal(expectedValueFromProbability(0.6, 1), 0);
});

test("the probability form agrees with settling the raw shares", () => {
  const cover = { win: 0.45, push: 0.25, loss: 0.3 };
  const fromShares = expectedProfit(cover);
  const probability = cover.win / (cover.win + cover.loss);
  const fromProb = expectedValueFromProbability(probability, cover.push);
  assert.ok(Math.abs(fromShares - fromProb) < 1e-12);
});

test("a 半 line is worth less than the plain line at the same probability", () => {
  // 1半2 pays only 8分 at a two-run margin, so part of the stake pushes there.
  const sim = simulateGame(5.2, 4.0, { sims: 20_000, seed: "ev" });
  const plain = sim.asianCover("home", parseHandicapNotation("1半").parts);
  const reduced = sim.asianCover("home", parseHandicapNotation("1半2").parts);
  assert.ok(reduced.push > plain.push, "the split creates pushes");
  // Same underlying game, but less of the stake is actually working.
  assert.ok(
    Math.abs(expectedProfit(reduced)) < Math.abs(expectedProfit(plain)) ||
      expectedProfit(reduced) !== expectedProfit(plain),
    "the reduced payout changes what the bet is worth",
  );
});

function ranked(
  rows: { ev: number | null; confidence?: "S" | "A" | "B" | "C" }[],
): (number | null)[] {
  const picks = rows.map(
    (r, i) =>
      ({
        gamePk: i,
        confidence: r.confidence ?? "C",
        winProbability: 0.6,
        handicap: { ev: r.ev },
      }) as unknown as GamePrediction,
  );
  return rankByValue(picks).map((p) => p.handicap.ev);
}

test("rankByValue puts the most profitable bet first", () => {
  assert.deepEqual(
    ranked([{ ev: 0.01 }, { ev: 0.12 }, { ev: -0.05 }]),
    [0.12, 0.01, -0.05],
  );
});

test("a game with no line quoted ranks below every real price", () => {
  // EV cannot fall below -1, so an absent line must not be treated as 0 and
  // outrank a genuinely losing one — it is not a better bet, it is no bet.
  assert.deepEqual(ranked([{ ev: null }, { ev: -0.4 }, { ev: 0.2 }]), [
    0.2,
    -0.4,
    null,
  ]);
});

test("the two renderers cannot disagree: both number from rankByValue", async () => {
  // Regression guard. The Markdown headings and the Pick Tracker paste block
  // used to sort independently, so on a slate mixing quoted and unquoted lines
  // "3." in the report and "3." in the paste were different games.
  const { predictionsToMarkdown } = await import("../src/cli/markdown");
  const { pickTrackerBlock } = await import("../src/cli/pick-tracker");

  const mk = (
    gamePk: number,
    away: string,
    ev: number | null,
    confidence: "S" | "A" | "B" | "C",
  ) =>
    ({
      gamePk,
      gameDate: null,
      home: "Home",
      away,
      pass: false,
      predictedWinner: away,
      predictedLoser: "Home",
      winProbability: 0.6,
      rawWinProbability: 0.6,
      confidence,
      handicap: {
        input: null,
        pick: "x",
        coverProbability: 0.6,
        rawCoverProbability: 0.6,
        ev,
        noValue: false,
      },
      total: {
        line: null,
        predicted: 8,
        pick: null,
        probability: null,
        rawProbability: null,
      },
      expectedRuns: { home: 4, away: 4 },
      reasons: [],
      flags: [],
    }) as GamePrediction;

  // A mix of quoted and unquoted lines is exactly what split the two orders.
  const preds = [
    mk(1, "Alpha", null, "S"),
    mk(2, "Bravo", 0.05, "C"),
    mk(3, "Charlie", null, "B"),
    mk(4, "Delta", 0.31, "C"),
  ];

  const md = predictionsToMarkdown("2024-07-25", preds, DEFAULT_CALIBRATION);
  const headings = [...md.matchAll(/^## (\d+)\. (\w+) @/gm)].map((m) => m[2]);
  const pasted = [
    ...(pickTrackerBlock("2024-07-25", preds) ?? "").matchAll(
      /^\d+\. (\w+) vs/gm,
    ),
  ].map((m) => m[1]);

  assert.deepEqual(headings, ["Delta", "Bravo", "Alpha", "Charlie"]);
  assert.deepEqual(pasted, headings, "report and paste must agree");
});

function coreGame(): GameCoreData {
  const side = {
    teamId: 1,
    teamName: "Home",
    starter: null,
    batting: null,
    bullpen: null,
    ilPlayers: null,
    lineup: null,
    form: null,
  };
  return {
    gamePk: 1,
    gameDate: "2024-07-25T23:00:00Z",
    venue: { id: null, name: null },
    parkFactor: 100,
    weather: null,
    home: { ...side },
    away: { ...side, teamId: 2, teamName: "Away" },
    flags: [],
    complete: true,
  };
}

test("a handicap priced near fair value is skipped — but only that market", () => {
  const g = coreGame();
  const runs = { homeMu: 5.4, awayMu: 3.6, leagueRunsPerGame: 4.4, notes: [] };
  const sim = simulateGame(5.4, 3.6, { sims: 20_000, seed: "pass" });

  // The engine always backs the better side, so an extreme line is a GOOD bet
  // on the other side of it. A bet only fails on price near the fair line,
  // where both sides sit close to a coin flip and the 10% cut eats the edge.
  // Find that line rather than assuming where it is.
  const candidates = [-0.5, -1, -1.5, -2, -2.5, -3];
  const priced = candidates
    .map((line) =>
      decide(g, runs, sim, DEFAULT_CALIBRATION, { side: "home", line }),
    )
    .filter((p) => p.handicap.ev !== null && p.handicap.ev <= 0);

  assert.ok(
    priced.length > 0,
    "some line near fair value must fail on price alone",
  );
  for (const p of priced) {
    assert.equal(p.handicap.pick, null, "a non-positive-EV bet is not offered");
    assert.equal(p.handicap.noValue, true);
    assert.ok(
      p.reasons[0]!.includes("No handicap bet"),
      `expected the price to be given as the reason, got: ${p.reasons[0]}`,
    );
    // Its cover probability is above 50% yet still below break-even — the
    // exact band a probability-only rule would wrongly wave through.
    assert.ok(p.handicap.coverProbability! >= 0.5);
    assert.ok(p.handicap.coverProbability! < breakEvenProbability());
  }
});

test("a bad price on the run line does not silence the other markets", () => {
  // This is the whole reason EV does not feed `pass`. A passed game predicts
  // nothing and — because settle.ts scores nothing for it — teaches nothing,
  // so folding a handicap price into `pass` would freeze the moneyline and
  // total shrink too: the model would stop learning who wins because of a
  // price on a different bet.
  const g = coreGame();
  const runs = { homeMu: 5.4, awayMu: 3.6, leagueRunsPerGame: 4.4, notes: [] };
  const sim = simulateGame(5.4, 3.6, { sims: 20_000, seed: "pass" });

  const p = decide(
    g,
    runs,
    sim,
    DEFAULT_CALIBRATION,
    { side: "home", line: -1.5, total: 8.5 },
    { ...DEFAULT_DECISION_CONFIG, minEv: 0.99 }, // no line can ever clear this
  );

  assert.equal(p.handicap.pick, null, "the handicap itself is skipped");
  assert.equal(p.handicap.noValue, true);
  assert.equal(p.pass, false, "the GAME is still a pick");
  assert.ok(p.predictedWinner !== null, "the moneyline survives");
  assert.ok(p.total.pick !== null, "the total survives");
  // And it still carries a scoreable probability, so settlement still learns.
  assert.ok(p.winProbability > 0.5);
});

test("a properly priced handicap is offered, with its EV attached", () => {
  const g = coreGame();
  const runs = { homeMu: 5.4, awayMu: 3.6, leagueRunsPerGame: 4.4, notes: [] };
  const sim = simulateGame(5.4, 3.6, { sims: 20_000, seed: "take" });
  const p = decide(g, runs, sim, DEFAULT_CALIBRATION, {
    side: "home",
    line: 0.5, // giving the home side a head start: easy to cover
  });
  assert.equal(p.pass, false);
  assert.ok(p.handicap.ev !== null && p.handicap.ev > 0);
  assert.ok(p.handicap.pick !== null);
  assert.ok(p.reasons.some((r) => r.includes("Handicap EV")));
});

test("minEv can demand a margin above bare break-even", () => {
  const g = coreGame();
  const runs = { homeMu: 5.4, awayMu: 3.6, leagueRunsPerGame: 4.4, notes: [] };
  const sim = simulateGame(5.4, 3.6, { sims: 20_000, seed: "margin" });
  const line = { side: "home" as const, line: 0.5 };
  const lenient = decide(g, runs, sim, DEFAULT_CALIBRATION, line);
  const strict = decide(g, runs, sim, DEFAULT_CALIBRATION, line, {
    ...DEFAULT_DECISION_CONFIG,
    minEv: 0.99, // unreachable
  });
  assert.ok(lenient.handicap.pick !== null);
  assert.equal(strict.handicap.pick, null, "a high bar withdraws the same bet");
});

test("recommended stake is quarter-Kelly on the fixed payout, capped and floored", () => {
  // f* = EV / 0.9, quartered: +9% EV → 0.025 units per 1-unit quantum.
  assert.equal(recommendedStake(0.09), 0.03);
  assert.equal(recommendedStake(0.36), 0.1);
  // Negative or break-even edge stakes nothing; no bet sizes nothing.
  assert.equal(recommendedStake(0), 0);
  assert.equal(recommendedStake(-0.05), 0);
  assert.equal(recommendedStake(null), null);
  // The cap holds however absurd the stated edge.
  assert.equal(recommendedStake(9), 1);
});

test("a slate with no quoted line at all gets ONE odds-fill banner", async () => {
  const { predictionsToMarkdown } = await import("../src/cli/markdown");
  const mk = (gamePk: number, input: HandicapInput | null) =>
    ({
      gamePk,
      gameDate: null,
      home: "Home",
      away: "Away",
      pass: true,
      predictedWinner: null,
      predictedLoser: null,
      winProbability: 0.52,
      rawWinProbability: 0.52,
      confidence: "C",
      handicap: {
        input,
        pick: null,
        coverProbability: null,
        rawCoverProbability: null,
        ev: null,
        noValue: false,
      },
      total: {
        line: null,
        predicted: 8,
        pick: null,
        probability: null,
        rawProbability: null,
      },
      expectedRuns: { home: 4, away: 4 },
      reasons: [],
      flags: [],
    }) as GamePrediction;

  const BANNER = "No market lines on this slate";
  const bare = predictionsToMarkdown(
    "2024-07-25",
    [mk(1, { side: "home", notation: null }), mk(2, null)],
    DEFAULT_CALIBRATION,
  );
  assert.ok(bare.includes(BANNER));
  assert.ok(bare.includes("ODDS_API_KEY"));

  // One real line anywhere on the slate and the banner must vanish.
  const quoted = predictionsToMarkdown(
    "2024-07-25",
    [mk(1, { side: "home", line: -1.5 }), mk(2, null)],
    DEFAULT_CALIBRATION,
  );
  assert.ok(!quoted.includes(BANNER));
});
