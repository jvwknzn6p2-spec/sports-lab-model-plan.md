import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyticMarginStats,
  checkIntegrity,
  cohorts,
  distributionCheck,
  flagRates,
  lockMargins,
  type AuditDay,
} from "../src/engine/audit";
import { DEFAULT_CALIBRATION, type GamePrediction } from "../src/engine/decision";
import { gamma, mulberry32, negBinomial } from "../src/engine/rng";
import { settle, type SettlementReport } from "../src/engine/settle";
import {
  SHARED_ENV_SD,
  simulateGame,
  TEAM_RUN_DISPERSION,
} from "../src/engine/simulate";

const NOW = new Date("2026-08-20T12:00:00Z");

function prediction(over: Partial<GamePrediction> & { gamePk: number }): GamePrediction {
  return {
    gameDate: null,
    home: "H",
    away: "A",
    pass: false,
    predictedWinner: "H",
    predictedLoser: "A",
    winProbability: 0.58,
    rawWinProbability: 0.6,
    confidence: "B",
    handicap: {
      input: { side: "home", notation: "0" },
      pick: "H -〈0〉",
      coverProbability: 0.58,
      rawCoverProbability: 0.6,
      ev: 0.1,
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
    ...over,
  };
}

function day(
  date: string,
  predictions: GamePrediction[],
  results: Record<string, { homeScore: number; awayScore: number }> | null,
  lockedAt = `${date}T13:00:00.000Z`,
): AuditDay {
  return {
    date,
    lock: { lockedAt, predictions },
    results,
    controlTowerHandicaps: null,
  };
}

/** The official report exactly as settle() would produce it. */
function officialReport(d: AuditDay): SettlementReport {
  return settle(d.date, d.lock!.predictions, d.results!, DEFAULT_CALIBRATION, NOW);
}

test("analytic margin moments match the simulator's draws", () => {
  const sim = simulateGame(4.8, 4.2, { sims: 60_000, seed: 99 });
  // Rebuild the margin variance from the simulator's own distribution via
  // cover probabilities is roundabout; instead simulate and compare directly
  // through meanMargin plus the analytic prediction.
  const a = analyticMarginStats(4.8, 4.2);
  // The simulator does not expose raw margins, so Monte Carlo the same
  // generative process (shared gamma environment → per-team NB) by hand with
  // the production constants and compare its variance to the formula.
  const sims = 60_000;
  let sum = 0;
  let sumSq = 0;
  const rng = mulberry32(4242);
  const k = 1 / (SHARED_ENV_SD * SHARED_ENV_SD);
  for (let i = 0; i < sims; i++) {
    const e = gamma(k, rng) / k;
    const m =
      negBinomial(4.8 * e, TEAM_RUN_DISPERSION, rng) -
      negBinomial(4.2 * e, TEAM_RUN_DISPERSION, rng);
    sum += m;
    sumSq += m * m;
  }
  const empirical = sumSq / sims - (sum / sims) ** 2;
  assert.ok(
    Math.abs(empirical - a.varMargin) / a.varMargin < 0.05,
    `analytic ${a.varMargin} vs empirical ${empirical}`,
  );
  assert.ok(a.correlation > 0.08 && a.correlation < 0.15, `corr=${a.correlation}`);
  assert.ok(sim.pHomeWin > 0.5, "sanity: favourite favoured");
});

test("a clean store passes integrity with zero issues", () => {
  const d = day(
    "2026-08-18",
    [prediction({ gamePk: 1 })],
    { "1": { homeScore: 5, awayScore: 3 } },
  );
  const official = officialReport(d);
  const issues = checkIntegrity(
    [d],
    [official],
    { gamesSettled: 1 },
    NOW,
  );
  assert.deepEqual(issues, []);
});

test("a doctored history is caught by the independent re-score", () => {
  const d = day(
    "2026-08-18",
    [prediction({ gamePk: 1 })],
    { "1": { homeScore: 5, awayScore: 3 } },
  );
  const doctored = {
    ...officialReport(d),
    winnerRecord: { wins: 0, losses: 1 }, // the pick actually WON
  };
  const issues = checkIntegrity([d], [doctored], { gamesSettled: 1 }, NOW);
  assert.ok(issues.some((i) => i.code === "resettle_mismatch"), JSON.stringify(issues));
});

test("overdue-but-missing results and unsettled dates are errors; future dates are not", () => {
  const overdueNoResults = day("2026-08-18", [prediction({ gamePk: 1 })], null);
  const futureNoResults = day("2026-08-21", [prediction({ gamePk: 2 })], null);
  const overdueUnsettled = day(
    "2026-08-17",
    [prediction({ gamePk: 3 })],
    { "3": { homeScore: 2, awayScore: 1 } },
  );
  const issues = checkIntegrity(
    [overdueNoResults, futureNoResults, overdueUnsettled],
    [],
    { gamesSettled: 0 },
    NOW,
  );
  assert.ok(issues.some((i) => i.code === "missing_results" && i.detail.includes("2026-08-18")));
  assert.ok(issues.some((i) => i.code === "unsettled_date" && i.detail.includes("2026-08-17")));
  assert.ok(!issues.some((i) => i.detail.includes("2026-08-21")), "future date must not be flagged");
});

test("duplicate history dates, counter drift and bad notations are flagged", () => {
  const d = day(
    "2026-08-18",
    [prediction({ gamePk: 1 })],
    { "1": { homeScore: 5, awayScore: 3 } },
  );
  d.controlTowerHandicaps = { "1": { side: "home", notation: "駄目" } };
  const official = officialReport(d);
  const issues = checkIntegrity(
    [d],
    [official, official],
    { gamesSettled: 99 },
    NOW,
  );
  assert.ok(issues.some((i) => i.code === "duplicate_history_date"));
  assert.ok(issues.some((i) => i.code === "calibration_counter_drift"));
  assert.ok(issues.some((i) => i.code === "bad_handicap_notation"));
});

test("lock margins measure distance to the deadline and flag late locks", () => {
  // Deadline is 13:55 UTC; 13:00 lock → +55 min, 14:00 lock → 5 min late.
  const onTime = day("2026-08-18", [], null, "2026-08-18T13:00:00.000Z");
  const late = day("2026-08-19", [], null, "2026-08-19T14:00:00.000Z");
  const margins = lockMargins([onTime, late]);
  assert.deepEqual(margins[0], { date: "2026-08-18", marginMinutes: 55, late: false });
  assert.deepEqual(margins[1], { date: "2026-08-19", marginMinutes: -5, late: true });
});

test("only recent late locks that are late under the CURRENT rule too become errors", async () => {
  const { runAudit } = await import("../src/engine/audit");
  // Old slate (outside the 14-day window): late but reported only.
  const oldLate = day(
    "2026-07-30",
    [prediction({ gamePk: 1, lockDeadline: "2026-07-30T13:21:00.000Z" })],
    { "1": { homeScore: 5, awayScore: 3 } },
    "2026-07-30T15:00:00.000Z",
  );
  // Recent slate from the superseded 22:21-era: late, displayed in S-4,
  // but never gates the run red — that era's lateness cannot recur.
  const legitimised = day(
    "2026-08-15",
    [prediction({ gamePk: 2, lockDeadline: "2026-08-15T13:21:00.000Z" })],
    { "2": { homeScore: 5, awayScore: 3 } },
    "2026-08-15T14:30:00.000Z",
  );
  // Recent slate produced under the CURRENT rule and locked after it: error.
  const freshLate = day(
    "2026-08-18",
    [prediction({ gamePk: 3, lockDeadline: "2026-08-18T13:55:00.000Z" })],
    { "3": { homeScore: 5, awayScore: 3 } },
    "2026-08-18T14:10:00.000Z",
  );
  const report = runAudit(
    [oldLate, legitimised, freshLate],
    [officialReport(oldLate), officialReport(legitimised), officialReport(freshLate)],
    { gamesSettled: 3 },
    NOW,
  );
  const lateIssues = report.issues.filter((i) => i.code === "late_lock");
  assert.equal(lateIssues.length, 1, JSON.stringify(lateIssues));
  assert.ok(lateIssues[0]!.detail.includes("2026-08-18"));
  // All three still appear in the S-4 margins with era-correct grading.
  assert.equal(report.lockMargins.filter((m) => m.late).length, 3);
});

test("a slate is judged by the deadline that was in force when it locked", () => {
  // A 22:21-era slate locked at 13:00 UTC: on time under its own stored
  // deadline (13:21) — and it must NOT be regraded by today's 13:55 rule.
  const eraSlate = day(
    "2026-07-30",
    [prediction({ gamePk: 1, lockDeadline: "2026-07-30T13:21:00.000Z" })],
    null,
    "2026-07-30T13:00:00.000Z",
  );
  const [m] = lockMargins([eraSlate]);
  assert.deepEqual(m, { date: "2026-07-30", marginMinutes: 21, late: false });
});

test("distribution check compares realized spread against the model's", () => {
  // 12 identical games, results exactly on the expected margin except two
  // outliers — a tiny empirical variance, far below the model's ~13.
  const preds = Array.from({ length: 12 }, (_, i) => prediction({ gamePk: i + 1 }));
  const results: Record<string, { homeScore: number; awayScore: number }> = {};
  for (let i = 1; i <= 12; i++) {
    results[String(i)] = i <= 10 ? { homeScore: 5, awayScore: 4 } : { homeScore: 8, awayScore: 1 };
  }
  const check = distributionCheck([day("2026-08-18", preds, results)])!;
  assert.equal(check.n, 12);
  assert.ok(check.modelMarginVariance > 10, `model var ${check.modelMarginVariance}`);
  assert.ok(
    check.empiricalMarginVariance < check.modelMarginVariance,
    "constructed data is far tamer than the model expects",
  );
  assert.ok(Math.abs(check.modelRunCorrelation - 0.11) < 0.03);
  // Fewer than 10 scored games → no verdict rather than a noisy one.
  assert.equal(distributionCheck([day("2026-08-18", preds.slice(0, 5), results)]), null);
});

test("flag rates count data-quality flags and skip audit-owned flags", () => {
  const preds = [
    prediction({ gamePk: 1, flags: ["[info] home_starter_xfip_estimated", "[warn] predicted_after_deadline"] }),
    prediction({ gamePk: 2, flags: ["[info] home_starter_xfip_estimated", "[warn] ev_outlier"] }),
    prediction({ gamePk: 3, flags: [] }),
  ];
  const rates = flagRates([day("2026-08-18", preds, null)]);
  assert.deepEqual(rates, [
    { flag: "[info] home_starter_xfip_estimated", games: 2, rate: 0.667 },
  ]);
});

test("cohorts score the watched patterns from settled picks", () => {
  const aligned = prediction({
    gamePk: 1,
    reasons: [
      "Starter edge: H (SP projFIP 3.50 vs 4.20)",
      "Offense edge: H (wOBA 0.330 vs 0.300)",
    ],
  });
  const awayPick = prediction({
    gamePk: 2,
    predictedWinner: "A",
    predictedLoser: "H",
    handicap: { ...prediction({ gamePk: 2 }).handicap, pick: "A +〈0〉" },
  });
  const outlier = prediction({ gamePk: 3, flags: ["[warn] ev_outlier"] });
  const legacy = prediction({ gamePk: 4 });
  // Strip the raw field the overhaul added → pre-overhaul engine.
  delete (legacy.handicap as { rawCoverProbability?: number | null }).rawCoverProbability;

  const results = {
    "1": { homeScore: 6, awayScore: 2 }, // aligned pick wins
    "2": { homeScore: 1, awayScore: 4 }, // away pick wins
    "3": { homeScore: 2, awayScore: 5 }, // outlier pick loses
    "4": { homeScore: 3, awayScore: 2 },
  };
  const stats = cohorts([day("2026-08-18", [aligned, awayPick, outlier, legacy], results)]);
  const by = (name: string) => stats.find((c) => c.cohort.startsWith(name))!;

  assert.deepEqual(
    { n: by("starter+offense").n, wins: by("starter+offense").wins },
    { n: 1, wins: 1 },
  );
  assert.deepEqual(
    { n: by("away-team").n, wins: by("away-team").wins },
    { n: 1, wins: 1 },
  );
  assert.deepEqual(
    { n: by("ev_outlier").n, losses: by("ev_outlier").losses },
    { n: 1, losses: 1 },
  );
  // All four use notation "0" → the real-line tripwire stays silent.
  assert.equal(by("real handicap line").n, 0);
  // Three carry the raw field; the stripped one does not.
  assert.equal(by("new engine").n, 3);
});

test("the real-line tripwire fires on substance, not spelling", () => {
  // "なし" resolves to the same zero line as "0" and must stay out of the
  // real-line cohort; a genuine 1半2 must land in it.
  const nashi = prediction({
    gamePk: 1,
    handicap: {
      ...prediction({ gamePk: 1 }).handicap,
      input: { side: "home", notation: "なし" },
    },
  });
  const real = prediction({
    gamePk: 2,
    handicap: {
      ...prediction({ gamePk: 2 }).handicap,
      input: { side: "home", notation: "1半2" },
      pick: "H -〈1半2〉",
    },
  });
  const stats = cohorts([
    day("2026-08-18", [nashi, real], {
      "1": { homeScore: 5, awayScore: 3 },
      "2": { homeScore: 5, awayScore: 3 },
    }),
  ]);
  const realLine = stats.find((c) => c.cohort.startsWith("real handicap"))!;
  assert.equal(realLine.n, 1);
});

test("a slate whose predict run crashed is a missing_lock error once overdue", () => {
  const crashed: AuditDay = {
    date: "2026-08-18", // overdue relative to NOW (2026-08-20)
    lock: null,
    results: null,
    controlTowerHandicaps: { "1": { side: "home", notation: "0" } },
  };
  const today: AuditDay = {
    date: "2026-08-20", // not overdue — no lock yet is normal
    lock: null,
    results: null,
    controlTowerHandicaps: null,
  };
  const issues = checkIntegrity([crashed, today], [], { gamesSettled: 0 }, NOW);
  assert.ok(issues.some((i) => i.code === "missing_lock" && i.detail.includes("2026-08-18")));
  assert.ok(!issues.some((i) => i.detail.includes("2026-08-20")));
});

test("a bad control-tower notation is caught even when predict never locked", () => {
  const poisoned: AuditDay = {
    date: "2026-08-19",
    lock: null,
    results: null,
    controlTowerHandicaps: { "7": { side: "home", notation: "1半11" } },
  };
  const issues = checkIntegrity([poisoned], [], { gamesSettled: 0 }, NOW);
  assert.ok(issues.some((i) => i.code === "bad_handicap_notation"));
});
