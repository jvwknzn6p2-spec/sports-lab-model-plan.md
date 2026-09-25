/**
 * Lock provenance: which record each pick may count toward, decided by WHEN
 * it was fixed (lock-provenance.ts). Two layers:
 *
 *   - the classification rules at their boundaries (deadline instant, first
 *     pitch instant, legacy rows, missing evidence);
 *   - invariants against the REAL committed ledgers of both leagues: the
 *     tier split must re-add to the headline exactly, restricting a day to
 *     all of its games must reproduce the stored day, and every settled game
 *     must be placeable from a committed lock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isAfterFirstPitch,
  LATE_FLAG,
  lockTierIndex,
  LOCK_TIERS,
  pickLockTier,
  POST_START_FLAG,
  withholdAfterFirstPitch,
  type ProvenanceLock,
} from "../src/engine/lock-provenance";
import {
  aggregateByLockTier,
  aggregateHistory,
  restrictReport,
} from "../src/engine/report";
import { settle, type SettlementReport } from "../src/engine/settle";
import type { GamePrediction } from "../src/engine/decision";
import { lockTiersToMarkdown, summaryToMarkdown } from "../src/cli/markdown";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

const START = "2026-09-20T05:00:00.000Z";
const DEADLINE = "2026-09-20T04:27:00.000Z";

const pick = (over: Partial<GamePrediction> = {}) => ({
  gamePk: 1,
  gameDate: START,
  flags: [] as string[],
  lockDeadline: DEADLINE,
  ...over,
});

test("predictedAt: before the deadline is on_time, the instant itself is late", () => {
  assert.equal(
    pickLockTier(pick({ predictedAt: "2026-09-20T04:26:59.999Z" }), null),
    "on_time",
  );
  // The deadline instant is the freeze (isPredictionLocked uses >=).
  assert.equal(
    pickLockTier(pick({ predictedAt: DEADLINE }), null),
    "late_pre_start",
  );
});

test("predictedAt: first pitch itself is post_start", () => {
  assert.equal(
    pickLockTier(pick({ predictedAt: "2026-09-20T04:59:59.999Z" }), null),
    "late_pre_start",
  );
  assert.equal(pickLockTier(pick({ predictedAt: START }), null), "post_start");
  assert.equal(
    pickLockTier(pick({ predictedAt: "2026-09-20T05:29:09.000Z" }), null),
    "post_start",
  );
});

test("predictedAt without the evidence to place it is unverified", () => {
  assert.equal(
    pickLockTier(pick({ predictedAt: "2026-09-20T04:00:00Z", lockDeadline: null }), null),
    "unverified",
  );
  assert.equal(
    pickLockTier(pick({ predictedAt: "2026-09-20T04:30:00Z", gameDate: null }), null),
    "unverified",
  );
});

test("legacy rows: the late flag plus lockedAt place the pick", () => {
  // No flag → produced before the deadline (checked 849/849 against git).
  assert.equal(pickLockTier(pick(), "2026-09-20T05:29:09Z"), "on_time");
  const late = pick({ flags: [LATE_FLAG] });
  assert.equal(pickLockTier(late, "2026-09-20T04:40:00Z"), "late_pre_start");
  assert.equal(pickLockTier(late, "2026-09-20T05:29:09Z"), "post_start");
  // Late, but the production time is unknowable → never verified.
  assert.equal(pickLockTier(late, null), "unverified");
  assert.equal(pickLockTier(late, "not a date"), "unverified");
});

test("a pick with no lock row is unverified, never on_time", () => {
  const index = lockTierIndex([
    { date: "2026-09-20", lock: { lockedAt: null, predictions: [pick()] } },
  ]);
  assert.equal(index.get("2026-09-20:1"), "on_time");
  assert.equal(index.get("2026-09-20:2"), undefined);
});

test("isAfterFirstPitch is inclusive of the first-pitch instant", () => {
  assert.equal(isAfterFirstPitch(START, new Date("2026-09-20T04:59:59.999Z")), false);
  assert.equal(isAfterFirstPitch(START, new Date(START)), true);
  assert.equal(isAfterFirstPitch(null, new Date(START)), false);
});

function staked(): GamePrediction {
  return {
    gamePk: 7,
    gameDate: START,
    home: "Home",
    away: "Away",
    pass: false,
    predictedWinner: "Home",
    predictedLoser: "Away",
    winProbability: 0.62,
    rawWinProbability: 0.64,
    confidence: "B",
    handicap: {
      input: { side: "home", notation: "0" },
      pick: "Home 〈0〉",
      coverProbability: 0.62,
      rawCoverProbability: 0.64,
      ev: 0.1,
      recommendedStake: 0.05,
      noValue: false,
    },
    total: {
      line: 7.5,
      predicted: 8.1,
      pick: "OVER",
      probability: 0.56,
      rawProbability: 0.57,
      ev: 0.02,
    },
    expectedRuns: { home: 4.3, away: 3.8 },
    reasons: ["edge"],
    flags: [],
  };
}

test("a pick produced after first pitch is withheld and settles nothing", () => {
  const w = withholdAfterFirstPitch(staked(), new Date("2026-09-20T05:29:09Z"));
  assert.equal(w.pass, true);
  assert.equal(w.predictedWinner, null);
  assert.equal(w.handicap.pick, null);
  assert.equal(w.handicap.recommendedStake, null);
  assert.equal(w.total.pick, null);
  assert.ok(w.flags.includes(POST_START_FLAG));
  assert.match(w.reasons[0]!, /^NO PICK: produced 2026-09-20T05:29:09/);
  // The probabilities stay as a diagnostic.
  assert.equal(w.winProbability, 0.62);

  const r = settle(
    "2026-09-20",
    [w],
    { "7": { homeScore: 5, awayScore: 1 } },
    {
      shrink: 1,
      tailShrink: 1,
      farTailShrink: 1,
      handicapShrink: 1,
      handicapTailShrink: 1,
      handicapFarTailShrink: 1,
      totalShrink: 1,
      totalTailShrink: 1,
      totalFarTailShrink: 1,
      gamesSettled: 0,
      brierSum: 0,
      updatedAt: null,
    },
    new Date("2026-09-21T00:00:00Z"),
  );
  assert.deepEqual(r.winnerRecord, { wins: 0, losses: 0 });
  assert.equal(r.handicapProfit, null);
  assert.deepEqual(r.totalRecord, { wins: 0, losses: 0 });
});

// ---------------------------------------------------------------------------
// Invariants against the real committed ledgers.

function loadLeague(dir: string): {
  history: SettlementReport[];
  locks: Array<{ date: string; lock: ProvenanceLock }>;
} {
  const root = join(PKG, dir);
  const history = readFileSync(join(root, "history.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SettlementReport);
  const predDir = join(root, "predictions");
  const locks = readdirSync(predDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({
      date: f.slice(0, 10),
      lock: JSON.parse(readFileSync(join(predDir, f), "utf8")) as ProvenanceLock,
    }));
  return { history, locks };
}

for (const dir of ["data", "data-npb"]) {
  if (!existsSync(join(PKG, dir, "history.jsonl"))) continue;

  test(`${dir}: restricting each day to all its games reproduces the stored day`, () => {
    const { history } = loadLeague(dir);
    const byDate = new Map<string, SettlementReport>();
    for (const r of history) byDate.set(r.date, r);
    for (const r of byDate.values()) {
      const all = restrictReport(r, () => true);
      for (const k of [
        "gamesSettled",
        "gamesPassed",
        "winnerRecord",
        "handicapRecord",
        "handicapProfit",
        "totalRecord",
        "meanBrier",
        "statedVsActual",
        "meanMarginError",
        "meanTotalError",
      ] as const) {
        assert.deepEqual(all[k], r[k], `${dir} ${r.date} ${k}`);
      }
    }
  });

  test(`${dir}: the tier split re-adds to the headline exactly`, () => {
    const { history, locks } = loadLeague(dir);
    const whole = aggregateHistory(history);
    const tiers = aggregateByLockTier(history, lockTierIndex(locks));
    const sum = (f: (s: (typeof tiers)["on_time"]) => number) =>
      LOCK_TIERS.reduce((a, t) => a + f(tiers[t]), 0);
    assert.equal(sum((s) => s.winnerRecord.wins), whole.winnerRecord.wins);
    assert.equal(sum((s) => s.winnerRecord.losses), whole.winnerRecord.losses);
    assert.equal(sum((s) => s.handicapRecord.wins), whole.handicapRecord.wins);
    assert.equal(sum((s) => s.handicapRecord.losses), whole.handicapRecord.losses);
    assert.equal(sum((s) => s.totalRecord.wins), whole.totalRecord.wins);
    assert.equal(sum((s) => s.totalRecord.losses), whole.totalRecord.losses);
    assert.equal(sum((s) => s.handicapStakes), whole.handicapStakes);
    assert.ok(
      Math.abs(
        sum((s) => s.handicapProfitTotal ?? 0) - (whole.handicapProfitTotal ?? 0),
      ) < 1e-6,
      `${dir}: tier profits do not re-add to the headline`,
    );
  });

  test(`${dir}: every settled game is placeable from a committed lock`, () => {
    const { history, locks } = loadLeague(dir);
    const tiers = aggregateByLockTier(history, lockTierIndex(locks));
    const u = tiers.unverified;
    assert.equal(
      u.gamesSettled + u.gamesPassed,
      0,
      `${dir}: settled games with no lock row — the record cannot place them`,
    );
  });
}

test("the summary leads with the verified tier and labels the mixed headline", () => {
  const { history, locks } = loadLeague("data-npb");
  const tiers = aggregateByLockTier(history, lockTierIndex(locks));
  const md = summaryToMarkdown(
    aggregateHistory(history),
    {
      shrink: 1,
      tailShrink: 1,
      farTailShrink: 1,
      handicapShrink: 1,
      handicapTailShrink: 1,
      handicapFarTailShrink: 1,
      totalShrink: 1,
      totalTailShrink: 1,
      totalFarTailShrink: 1,
      gamesSettled: 0,
      brierSum: 0,
      updatedAt: null,
    },
    tiers,
  );
  const verified = md.indexOf("## Verified pre-game record");
  const mixed = md.indexOf("## All picks (every tier combined — reference)");
  assert.ok(verified > 0 && mixed > verified, md.slice(0, 600));
  assert.match(lockTiersToMarkdown(tiers), /\*\*on_time\*\*/);
});

test("the audit names a staked post-start pick, and ignores a withheld one", async () => {
  const { runAudit } = await import("../src/engine/audit");
  const lockedAt = "2026-09-20T05:29:09.000Z"; // after the 05:00 first pitch
  const stakedLate = { ...staked(), flags: [LATE_FLAG], lockDeadline: DEADLINE };
  const withheld = {
    ...withholdAfterFirstPitch(staked(), new Date(lockedAt)),
    gamePk: 8,
    flags: [LATE_FLAG, POST_START_FLAG],
    lockDeadline: DEADLINE,
  };
  const report = runAudit(
    [
      {
        date: "2026-09-20",
        lock: { lockedAt, predictions: [stakedLate, withheld] },
        results: null,
        controlTowerHandicaps: null,
      },
    ],
    [],
    { gamesSettled: 0 },
    new Date("2026-09-21T00:00:00Z"),
  );
  const post = report.issues.filter((i) => i.code === "post_start_pick");
  assert.equal(post.length, 1);
  assert.equal(post[0]!.severity, "error");
  assert.match(post[0]!.detail, /1 pick\(s\).*\(7\)/);
});
