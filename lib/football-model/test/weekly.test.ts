import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { footballWeeklyMarkdown, isoWeekMonday, isoWeekOf, jstDate, lastCompleteWeek } from "../src/weekly.ts";
import { Ledger } from "../src/ledger.ts";
import { NAMES } from "../src/pipeline.ts";

test("週: キックオフの JST 日付で数え、既定は JST の直近の完了週", () => {
  assert.equal(isoWeekMonday("2026-W38"), "2026-09-14");
  assert.equal(isoWeekOf("2026-09-20"), "2026-W38");
  // 欧州の夜 9/20 19:30Z は JST 9/21 04:30 → 翌週の試合
  assert.equal(jstDate("2026-09-20T19:30:00Z"), "2026-09-21");
  assert.equal(lastCompleteWeek("2026-09-21T00:00:00Z"), "2026-W38"); // 月曜 09:00 JST
  assert.equal(lastCompleteWeek("2026-09-20T14:00:00Z"), "2026-W37"); // 日曜 23:00 JST
});

test("空の台帳は「—」で、差分も 0 も作らない", () => {
  const md = footballWeeklyMarkdown({
    week: "2026-W39", leagues: ["E0"], names: NAMES, predictions: [], evaluations: [], matches: new Map(),
    nowIso: "2026-09-28T00:00:00Z", commit: null, lastRecordedAt: null, lastMatchDate: null,
  });
  assert.match(md, /\| プレミアリーグ \| — \| — \| — \| — \| — \| — \| — \| — \|/);
  assert.match(md, /\| 決着 \| — \| — \| — \|/);
  assert.match(md, /今週キックオフの予想が無い/);
  assert.doesNotMatch(md, /NaN|undefined/);
});

const LEDGER = new URL("../../../football/ledger/", import.meta.url).pathname;

test("本番台帳: 除外した予想は数えず、指標の定義を明記する", { skip: !existsSync(join(LEDGER, "predictions.ndjson")) }, () => {
  const L = new Ledger(LEDGER);
  const md = footballWeeklyMarkdown({
    week: "2026-W38", leagues: ["E0", "I1", "SP1"], names: NAMES,
    predictions: L.predictions(), evaluations: L.evaluations(), matches: L.currentMatches(),
    nowIso: "2026-09-25T00:00:00Z", commit: "abc", lastRecordedAt: null, lastMatchDate: null,
  });
  assert.match(md, /3 分類 Brier は 0〜2（正規化なし・一様予想で 0\.667）/);
  assert.match(md, /RPS は 0〜1（K−1=2 で正規化）/);
  assert.match(md, /集計から除いた予想 5 件/);
  assert.doesNotMatch(md, /NaN|undefined/);
});
