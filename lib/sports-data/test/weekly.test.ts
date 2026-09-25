/**
 * The weekly operations report (engine/weekly.ts): ISO-week arithmetic, the
 * honesty rules ("—" for no data, never a difference against nothing), the
 * verified tier kept apart, and a render against the real ledgers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isoWeekMonday,
  isoWeekOf,
  lastCompleteWeek,
  weekDates,
  weeklyToMarkdown,
  type WeeklyDay,
} from "../src/engine/weekly";
import { lockTierIndex, type ProvenanceLock } from "../src/engine/lock-provenance";
import type { SettlementReport } from "../src/engine/settle";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

test("ISO weeks: Monday, membership and the year boundary", () => {
  assert.equal(isoWeekMonday("2026-W39"), "2026-09-21");
  assert.equal(isoWeekOf("2026-09-21"), "2026-W39");
  assert.equal(isoWeekOf("2026-09-27"), "2026-W39");
  assert.equal(isoWeekOf("2026-09-28"), "2026-W40");
  // 2027-01-01 is a Friday → still ISO week 53 of 2026
  assert.equal(isoWeekOf("2027-01-01"), "2026-W53");
  assert.equal(isoWeekMonday("2026-W01"), "2025-12-29");
  assert.deepEqual(weekDates("2026-W39"), [
    "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27",
  ]);
  assert.throws(() => isoWeekMonday("2026-39"));
});

test("the default week is the last COMPLETE one, in JST", () => {
  // Monday 2026-09-28 08:23 UTC = 17:23 JST Monday → last week W39
  assert.equal(lastCompleteWeek(new Date("2026-09-28T08:23:00Z")), "2026-W39");
  // Sunday 2026-09-27 20:00 UTC is already Monday 05:00 JST → W39 complete
  assert.equal(lastCompleteWeek(new Date("2026-09-27T20:00:00Z")), "2026-W39");
  // Sunday 2026-09-27 10:00 UTC is Sunday 19:00 JST → W38 is the last complete
  assert.equal(lastCompleteWeek(new Date("2026-09-27T10:00:00Z")), "2026-W38");
});

test("an empty store renders dashes, not zeros or differences", () => {
  const md = weeklyToMarkdown({
    league: "MLB",
    week: "2026-W39",
    days: [],
    history: [],
    tierIndex: new Map(),
    issues: [],
    commit: null,
    generatedAt: "2026-09-28T08:23:00.000Z",
    slateDateIsUsDate: true,
  });
  assert.match(md, /\| 勝敗予想 \| — \| — \| — \|/);
  assert.match(md, /今週の予想ロックは無い/);
  assert.match(md, /コミット UNKNOWN/);
  assert.match(md, /日本時間では各日の翌朝/);
  assert.doesNotMatch(md, /NaN|undefined/);
});

function loadLeague(dir: string) {
  const root = join(PKG, dir);
  const history = readFileSync(join(root, "history.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SettlementReport);
  const locks = readdirSync(join(root, "predictions"))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({
      date: f.slice(0, 10),
      lock: JSON.parse(readFileSync(join(root, "predictions", f), "utf8")) as ProvenanceLock,
    }));
  return { history, locks };
}

test("real NPB ledger: the verified week re-adds from the ledger and the week's tiers are counted", { skip: !existsSync(join(PKG, "data-npb", "history.jsonl")) }, () => {
  const { history, locks } = loadLeague("data-npb");
  const days: WeeklyDay[] = locks.map(({ date, lock }) => ({
    date,
    slate: true,
    lock: lock as WeeklyDay["lock"],
    results: null,
  }));
  const md = weeklyToMarkdown({
    league: "NPB",
    week: "2026-W38",
    days,
    history,
    tierIndex: lockTierIndex(locks),
    issues: [],
    commit: "abc1234",
    generatedAt: "2026-09-28T08:23:00.000Z",
    slateDateIsUsDate: false,
  });
  // 9/19 and 9/20 each had three picks produced after first pitch (weekend day games)
  assert.match(md, /\| 2026-09-19 \| ✓ \| 6 \| 3 \/ 0 \/ 3 \|/);
  assert.match(md, /\| 2026-09-20 \| ✓ \| 6 \| 3 \/ 0 \/ 3 \|/);
  assert.match(md, /締切前に固定できた割合: \*\*25\/31/);
  assert.match(md, /開始後に生成された予想が 6 件ある/);
  assert.match(md, /日本時間の試合日/);
  assert.doesNotMatch(md, /NaN|undefined/);
});
