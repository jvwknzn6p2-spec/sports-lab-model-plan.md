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
import { SHARED_ENV_SD, simulateGame } from "../src/engine/simulate";
import {
  calibrate,
  calibrateBanded,
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
  EV_OUTLIER_THRESHOLD,
  rankByValue,
  rankingEv,
  TAIL_START,
  type GamePrediction,
} from "../src/engine/decision";
import { settle, updateCalibration } from "../src/engine/settle";
import { gamma, mulberry32, negBinomial, poisson } from "../src/engine/rng";

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

test("gamma sampler matches its first two moments", () => {
  const rng = mulberry32(7);
  const shape = 9;
  const n = 40_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = gamma(shape, rng);
    sum += x;
    sumSq += x * x;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  // Gamma(k, 1): mean k, variance k.
  assert.ok(Math.abs(mean - shape) < 0.15, `mean=${mean}`);
  assert.ok(Math.abs(variance - shape) < 0.6, `var=${variance}`);
  // The shape<1 boost path must also hold its mean.
  const rng2 = mulberry32(8);
  let sumSmall = 0;
  for (let i = 0; i < n; i++) sumSmall += gamma(0.5, rng2);
  assert.ok(Math.abs(sumSmall / n - 0.5) < 0.05, `mean=${sumSmall / n}`);
});

test("negative binomial keeps the mean but is overdispersed", () => {
  const rng = mulberry32(11);
  const mu = 4.5;
  const size = 9;
  const n = 40_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = negBinomial(mu, size, rng);
    sum += x;
    sumSq += x * x;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean - mu) < 0.1, `mean=${mean}`);
  // Var = mu + mu²/size = 4.5 + 2.25 = 6.75 — well above the Poisson's 4.5.
  const expected = mu + (mu * mu) / size;
  assert.ok(Math.abs(variance - expected) < 0.5, `var=${variance}`);
  // size = ∞ must recover the plain Poisson.
  const rng2 = mulberry32(11);
  const rng3 = mulberry32(11);
  assert.equal(
    negBinomial(mu, Number.POSITIVE_INFINITY, rng2),
    poisson(mu, rng3),
  );
});

test("overdispersion + shared environment pull the favourite toward 50%", () => {
  // The Poisson variant is the pre-audit engine. Its favourite probabilities
  // ran ~24pt hot in the 65–70% band; the wider margin distribution must
  // quote the same matchup lower.
  const nb = simulateGame(5.2, 3.8, { sims: 40_000, seed: 21 });
  const po = simulateGame(5.2, 3.8, {
    sims: 40_000,
    seed: 21,
    dispersion: Number.POSITIVE_INFINITY,
    envSd: 0,
  });
  assert.ok(
    nb.pHomeWin < po.pHomeWin - 0.02,
    `nb=${nb.pHomeWin} poisson=${po.pHomeWin}`,
  );
  // Both still favour the stronger side.
  assert.ok(nb.pHomeWin > 0.55);
});

test("the shared environment factor correlates the two teams' runs", () => {
  // A common multiplier moves both teams together, so its signature is in
  // the TOTAL: more mass at extreme combined scores than independent draws
  // can produce. Compare the same matchup with the environment on and off.
  // An explicit non-zero sd: the production default is now 0 (the real
  // record showed no residual correlation), so the mechanism has to be
  // switched on deliberately to be tested at all.
  const withEnv = simulateGame(4.5, 4.5, { sims: 30_000, seed: 5, envSd: 0.2 });
  const without = simulateGame(4.5, 4.5, { sims: 30_000, seed: 5, envSd: 0 });
  const hiWith = withEnv.totalProb(14.5).over;
  const hiWithout = without.totalProb(14.5).over;
  assert.ok(hiWith > hiWithout, `env tail ${hiWith} vs indep ${hiWithout}`);
});

test("banded calibration is continuous, monotone and symmetric", () => {
  const core = 0.85;
  const tail = 0.7;
  // Continuity at the boundary.
  const below = calibrateBanded(TAIL_START - 1e-9, core, tail);
  const above = calibrateBanded(TAIL_START + 1e-9, core, tail);
  assert.ok(Math.abs(below - above) < 1e-6);
  // Monotone: a bigger raw edge can never be quoted smaller.
  let prev = -1;
  for (let p = 0.5; p <= 0.99; p += 0.01) {
    const q = calibrateBanded(p, core, tail);
    assert.ok(q > prev, `p=${p}`);
    prev = q;
  }
  // Symmetric around 50%: both sides of the same game agree.
  const up = calibrateBanded(0.72, core, tail);
  const down = calibrateBanded(0.28, core, tail);
  assert.ok(Math.abs(up + down - 1) < 1e-9);
  // Inside the core band it IS the linear map.
  assert.equal(calibrateBanded(0.6, core, tail), calibrate(0.6, core));
  // Beyond it, the tail is shrunk harder than the core alone would.
  assert.ok(calibrateBanded(0.75, core, tail) < calibrate(0.75, core));
});

test("an implausibly large EV is flagged, capped and demoted in rank", () => {
  // rankingEv reflects past the threshold instead of capping: +40% must rank
  // BELOW an honest +24%, not tie every other outlier at the cap.
  assert.equal(rankingEv(0.2), 0.2);
  assert.ok(rankingEv(0.4) < rankingEv(0.24));
  assert.ok(rankingEv(0.26) < rankingEv(0.25));

  const fake = (ev: number | null, confidence: "S" | "B", win: number) =>
    ({
      gamePk: 1,
      gameDate: null,
      home: "H",
      away: "A",
      pass: false,
      predictedWinner: "H",
      predictedLoser: "A",
      winProbability: win,
      rawWinProbability: win,
      confidence,
      handicap: {
        input: null,
        pick: ev === null ? null : "H -1.5",
        coverProbability: ev === null ? null : win,
        rawCoverProbability: ev === null ? null : win,
        ev,
        noValue: false,
      },
      total: {
        line: null,
        predicted: 9,
        pick: null,
        probability: null,
        rawProbability: null,
      },
      expectedRuns: { home: 5, away: 4 },
      reasons: [],
      flags: [],
    }) satisfies GamePrediction;

  const honest = fake(0.18, "B", 0.6);
  const outlier = fake(0.45, "S", 0.7);
  const ranked = rankByValue([outlier, honest]);
  assert.equal(ranked[0], honest, "the honest EV outranks the outlier");

  // decide() itself: force an enormous edge so the quoted EV clears the
  // threshold, then check the pick is flagged and demoted from S.
  const strong = simulateGame(7.5, 2.5, { sims: 10_000, seed: 9 });
  assert.ok(strong.pHomeWin > 0.8);
  return loadSlateGames().then((games) => {
    // A REAL line: the guard measures disagreement with a quoted price, so a
    // pick'em — which has no price to disagree with — is out of its scope.
    const p = decide(games[0]!, expectedRuns(games[0]!, 2024), strong, {
      ...DEFAULT_CALIBRATION,
    }, {
      side: "home",
      line: -1.5,
    });
    assert.ok(p.handicap.ev !== null && p.handicap.ev > EV_OUTLIER_THRESHOLD);
    assert.ok(p.flags.includes("[warn] ev_outlier"), p.flags.join(","));
    assert.notEqual(p.confidence, "S");
    assert.notEqual(p.confidence, "A");
    assert.ok(
      p.reasons.some((r) => r.startsWith("EV outlier")),
      "the demotion explains itself",
    );
  });
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

  // Wider (correctly calibrated) margins mean a 1.9-run edge no longer
  // covers -1.5 profitably; this test needs a favourite big enough to make
  // the quoted line a real bet.
  const strong = simulateGame(6.2, 3.2, { sims: 10_000, seed: 1 });
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
  // Stated ~65%, actual 50% → overconfident. Which BAND absorbs the lesson
  // depends on where the stated probabilities landed, so assert on the map
  // itself: after overconfident evidence, the same raw probability must be
  // quoted lower than before.
  const quote = (s: typeof report.calibrationAfter) =>
    calibrateBanded(0.7, s.shrink, s.tailShrink);
  assert.ok(quote(report.calibrationAfter) < quote(report.calibrationBefore));
  assert.equal(report.calibrationAfter.gamesSettled, 2);

  // Underconfidence moves the quote UP (both picks win).
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
  assert.ok(quote(up.calibrationAfter) > quote(DEFAULT_CALIBRATION));
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
      handicapProfit: null,
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
  // A stated 99% is a TAIL bet. This row carries no far-tail stamp, so it is
  // legacy to the far-tail split and teaches both tail bands identically; one
  // catastrophic game moves them only slightly (damping 1/21) and leaves the
  // core band untouched.
  assert.ok(
    s.tailShrink > 0.65 && s.tailShrink < DEFAULT_CALIBRATION.tailShrink,
    `tailShrink=${s.tailShrink}`,
  );
  assert.equal(s.farTailShrink, s.tailShrink);
  assert.equal(s.shrink, DEFAULT_CALIBRATION.shrink);
});

test("a thin winner edge PASSes the moneyline but keeps a priced handicap", async () => {
  const games = await loadSlateGames();
  const g = games[0]!;
  const runs = expectedRuns(g, 2024);
  const strong = simulateGame(6.2, 3.2, { sims: 10_000, seed: 1 });
  const line = { side: "home" as const, line: -1.5, total: 8.5 };

  // Force the winner gate to reject while the inputs stay clean, so the only
  // thing under test is whether a dull moneyline drags the run line down
  // with it. It must not: the handicap is a separate bet at a separate price.
  const thin = decide(g, runs, strong, DEFAULT_CALIBRATION, line, {
    ...DEFAULT_DECISION_CONFIG,
    passThreshold: 0.99,
  });
  assert.equal(thin.pass, true);
  assert.equal(thin.predictedWinner, null, "the moneyline is off");
  assert.equal(thin.total.pick, null, "the total is off");
  assert.ok(thin.handicap.pick !== null, "the handicap must survive");
  assert.ok(thin.handicap.ev !== null && thin.handicap.ev > 0);
  assert.ok(thin.reasons[0]!.startsWith("PASS:"));

  // Bad INPUTS are different: nothing priced off them can be trusted.
  const dirty = decide(
    { ...g, complete: false },
    runs,
    strong,
    DEFAULT_CALIBRATION,
    line,
  );
  assert.equal(dirty.pass, true);
  assert.equal(dirty.handicap.pick, null, "incomplete data kills every market");
  assert.equal(dirty.handicap.noValue, false);

  // And the settler must score the surviving stake — money that is placed and
  // never settled is money the record cannot see.
  const rep = settle(
    "2026-08-20",
    [thin],
    { [String(thin.gamePk)]: { homeScore: 7, awayScore: 2 } },
    DEFAULT_CALIBRATION,
    new Date("2026-08-21T12:00:00Z"),
  );
  const scored = rep.games[0]!;
  assert.equal(scored.pass, true);
  assert.equal(scored.winnerCorrect, null, "no moneyline bet to score");
  assert.equal(scored.handicapCorrect, true);
  assert.ok(scored.handicapProfit !== null && scored.handicapProfit > 0);
  assert.equal(rep.handicapProfit, scored.handicapProfit);
  assert.equal(
    scored.confidence,
    thin.confidence,
    "a handicap-only bet still belongs to a confidence band",
  );
});

test("simulateGame refuses a NaN dispersion instead of falling back to Poisson", () => {
  assert.throws(
    () => simulateGame(4.5, 4.5, { sims: 10, seed: 1, dispersion: Number.NaN }),
    /dispersion must be a positive number/,
  );
  assert.throws(
    () => simulateGame(4.5, 4.5, { sims: 10, seed: 1, envSd: Number.NaN }),
    /envSd must be a non-negative finite number/,
  );
  // Infinity is the Poisson limit and stays a legal, deliberate request.
  assert.ok(
    simulateGame(4.5, 4.5, {
      sims: 100,
      seed: 1,
      dispersion: Number.POSITIVE_INFINITY,
    }).pHomeWin > 0,
  );
});

test("a pick'em handicap is the moneyline and answers to the same gate", async () => {
  const games = await loadSlateGames();
  const g = games[0]!;
  const runs = expectedRuns(g, 2024);
  const strong = simulateGame(6.2, 3.2, { sims: 10_000, seed: 1 });
  const thin = { ...DEFAULT_DECISION_CONFIG, passThreshold: 0.99 };

  // A 0 line returns the stake on a level score and is otherwise the winner
  // market restated — 143 of 143 settled pick'ems produced the identical
  // result to the winner pick. Letting it through a thin-edge PASS would
  // re-enter the exact proposition the winner gate just rejected.
  const pickem = decide(
    g,
    runs,
    strong,
    DEFAULT_CALIBRATION,
    { side: "home", notation: "0" },
    thin,
  );
  assert.equal(pickem.pass, true);
  assert.equal(pickem.handicap.pick, null, "a pick'em must follow the winner gate");
  assert.equal(pickem.handicap.noValue, false, "suppressed is not 'no value'");

  // A REAL line is a separate bet at a separate price and still survives.
  const real = decide(
    g,
    runs,
    strong,
    DEFAULT_CALIBRATION,
    { side: "home", line: -1.5 },
    thin,
  );
  assert.equal(real.pass, true);
  assert.ok(real.handicap.pick !== null, "a real line stays decoupled");

  // Clearing the winner gate puts the pick'em back on the book.
  const clear = decide(g, runs, strong, DEFAULT_CALIBRATION, {
    side: "home",
    notation: "0",
  });
  assert.equal(clear.pass, false);
  assert.ok(clear.handicap.pick !== null);
});

test("the EV-outlier guard stays out of the pick'em market", async () => {
  const games = await loadSlateGames();
  const g = games[0]!;
  const runs = expectedRuns(g, 2024);
  // A blowout favourite: at a 0 line EV is a monotone restatement of the win
  // probability, so EV > 0.25 is just "cover > 65.8%" and the guard would
  // demote the model's BEST picks — a 66% pick ranking below a 63% one.
  const huge = simulateGame(7.5, 2.6, { sims: 10_000, seed: 7 });
  const pickem = decide(g, runs, huge, DEFAULT_CALIBRATION, {
    side: "home",
    notation: "0",
  });
  assert.ok(
    pickem.handicap.ev !== null && pickem.handicap.ev > EV_OUTLIER_THRESHOLD,
    `needs an EV past the threshold to be a real test (${pickem.handicap.ev})`,
  );
  assert.ok(
    !pickem.flags.includes("[warn] ev_outlier"),
    `pick'em must not trip the market-disagreement guard: ${pickem.flags}`,
  );
  assert.equal(pickem.confidence, "S", "the best pick must stay the best pick");

  // At a real line the guard is meaningful and still fires.
  const real = decide(g, runs, huge, DEFAULT_CALIBRATION, {
    side: "home",
    line: -1.5,
  });
  assert.ok(real.handicap.ev !== null && real.handicap.ev > EV_OUTLIER_THRESHOLD);
  assert.ok(real.flags.includes("[warn] ev_outlier"), real.flags.join(","));
  assert.equal(real.confidence, "B", "capped by the guard");
});
