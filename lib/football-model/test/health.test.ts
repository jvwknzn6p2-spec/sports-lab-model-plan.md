/**
 * 取込・決済の健全性。**「日次が緑なのに記録が凍る」を検知できること**を固定する
 * （2026-09-16〜17 に実発生。取得元 3 経路が同時に落ち、2 回の成功実行で結果 0 件）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INGEST_FAIL_HOURS,
  INGEST_WARN_HOURS,
  ingestHealth,
  ingestLevel,
  settlementBacklog,
} from "../src/health.ts";
import type { LedgerEvaluation, LedgerPrediction, LedgerResult } from "../src/ledger.ts";

const result = (date: string, recordedAt: string): LedgerResult => ({
  league: "E0", date, home: "Arsenal", away: "Chelsea", homeGoals: 1, awayGoals: 0, source: "test", recordedAt,
});

const pred = (id: string, kickoffAt: string): LedgerPrediction => ({
  id, providerId: `p-${id}`, league: "E0", kickoffAt, cutoffAt: kickoffAt, publishedAt: kickoffAt,
  model: "dc-v2-ridge", asOf: kickoffAt, nTrain: 900, pHome: 0.5, pDraw: 0.25, pAway: 0.25,
  lambdaHome: 1.4, lambdaAway: 1.1, market: null, marketFetchedAt: null, fingerprint: id,
});

const evaluation = (predictionId: string): LedgerEvaluation => ({
  predictionId, providerId: `p-${predictionId}`, league: "E0", result: "H", homeGoals: 1, awayGoals: 0,
  rps: 0.1, brier: 0.2, logloss: 0.5, marketRps: null, evaluatedAt: "2026-09-17T00:00:00.000Z",
});

test("ingestHealth: 最後に取り込んだ時刻と最新の試合日を返す", () => {
  const h = ingestHealth(
    [result("2026-09-12", "2026-09-14T00:05:00.000Z"), result("2026-09-14", "2026-09-15T00:29:00.000Z")],
    "2026-09-17T01:00:00.000Z",
  );
  assert.equal(h.lastRecordedAt, "2026-09-15T00:29:00.000Z");
  assert.equal(h.lastMatchDate, "2026-09-14");
  assert.equal(h.results, 2);
  assert.ok(Math.abs((h.hoursSinceRecord ?? 0) - 48.52) < 0.02, `${h.hoursSinceRecord}`);
});

test("ingestHealth: 行の順序に依存しない（台帳は追記順とは限らない）", () => {
  const rows = [result("2026-09-14", "2026-09-15T00:29:00.000Z"), result("2026-09-12", "2026-09-14T00:05:00.000Z")];
  assert.equal(ingestHealth(rows, "2026-09-17T01:00:00.000Z").lastRecordedAt, "2026-09-15T00:29:00.000Z");
});

test("ingestLevel: 36h で warn・72h で fail", () => {
  const at = (hours: number) => ingestLevel(ingestHealth([result("2026-09-14", "2026-09-14T00:00:00.000Z")],
    new Date(Date.parse("2026-09-14T00:00:00.000Z") + hours * 3_600_000).toISOString()));
  assert.equal(at(1), "ok");
  assert.equal(at(INGEST_WARN_HOURS - 0.1), "ok");
  assert.equal(at(INGEST_WARN_HOURS), "warn");
  assert.equal(at(INGEST_FAIL_HOURS - 0.1), "warn");
  assert.equal(at(INGEST_FAIL_HOURS), "fail");
  // 実発生の再現: 9/15 00:29Z が最後 → 9/17 01:31Z の回は warn（まだ fail ではない）
  assert.equal(at(49), "warn");
  // 翌日（9/18）も入らなければ fail になる
  assert.equal(at(73), "fail");
});

test("ingestLevel: 結果が 1 件も無い台帳は故障ではない（立ち上げ直後）", () => {
  assert.equal(ingestLevel(ingestHealth([], "2026-09-17T01:00:00.000Z")), "ok");
});

test("settlementBacklog: 開始済み・未決済を古い順で返し、決済済みは外す", () => {
  const preds = [
    pred("a", "2026-09-06T17:45:00.000Z"), // 最古
    pred("b", "2026-09-15T19:00:00.000Z"),
    pred("c", "2026-09-14T19:00:00.000Z"),
  ];
  const b = settlementBacklog(preds, [evaluation("c")], "2026-09-17T02:00:00.000Z");
  assert.deepEqual(b.map((x) => x.predictionId), ["a", "b"]);
  assert.ok(Math.abs(b[0].ageHours - 248.25) < 0.01, `${b[0].ageHours}`);
});

test("settlementBacklog: 終わったばかりの試合は数えない（結果待ちであって故障ではない）", () => {
  const preds = [pred("fresh", "2026-09-17T00:00:00.000Z")];
  assert.equal(settlementBacklog(preds, [], "2026-09-17T02:00:00.000Z").length, 0, "2 時間後を数えている");
  assert.equal(settlementBacklog(preds, [], "2026-09-17T07:00:00.000Z").length, 1);
});

test("settlementBacklog: 未開始の予想は数えない", () => {
  assert.equal(settlementBacklog([pred("future", "2026-09-20T18:00:00.000Z")], [], "2026-09-17T02:00:00.000Z").length, 0);
});
