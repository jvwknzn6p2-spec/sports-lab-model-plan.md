/**
 * 取込・決済の健全性。**「日次が緑なのに記録が凍る」を検知できること**を固定する
 * （2026-09-16〜17 に実発生。取得元 3 経路が同時に落ち、2 回の成功実行で結果 0 件）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INGEST_FAIL_HOURS,
  INGEST_WARN_HOURS,
  RESULT_DUE_HOURS,
  ZERO_FIXTURE_FAIL_RUNS,
  ingestDue,
  ingestHealth,
  ingestLevel,
  missedSeals,
  nextZeroFixtureRuns,
  publishLevel,
  runTotals,
  seasonLive,
  settlementBacklog,
  type MissedSeal,
  type RunReport,
} from "../src/health.ts";
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction, LedgerResult } from "../src/ledger.ts";

const ledgerMatch = (kickoffAt: string, league = "E0"): LedgerMatch => ({
  providerId: `m-${league}-${kickoffAt}`, league, kickoffAt, cutoffAt: kickoffAt,
  home: "Arsenal", away: "Chelsea", recordedAt: kickoffAt,
});

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

test("ingestLevel: 取り込むべき試合があるとき 36h で warn・72h で fail", () => {
  const base = "2026-09-14T00:00:00.000Z";
  // 最後の取込より後にキックオフし、猶予も過ぎた試合を 1 つ置く（＝結果が来ているはず）
  const due = { league: "E0", kickoffAt: "2026-09-14T01:00:00.000Z", ageHours: 999 };
  const at = (hours: number) =>
    ingestLevel(
      ingestHealth([result("2026-09-14", base)], new Date(Date.parse(base) + hours * 3_600_000).toISOString()),
      due,
    );
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
  assert.equal(ingestLevel(ingestHealth([], "2026-09-17T01:00:00.000Z"), null), "ok");
});

test("ingestLevel: 取り込むべき試合が無ければ、何時間沈黙していても ok", () => {
  // 国際試合週間（2026-09-22〜10-09）の再現。時間だけで測ると 2 週間赤くなる
  const h = ingestHealth([result("2026-09-20", "2026-09-23T00:20:16.826Z")], "2026-10-05T00:29:00.000Z");
  assert.ok((h.hoursSinceRecord ?? 0) > INGEST_FAIL_HOURS * 4, `${h.hoursSinceRecord}`);
  assert.equal(ingestLevel(h, null), "ok");
});

test("ingestDue: 最後の取込より後にキックオフし、猶予を過ぎた試合だけを数える", () => {
  const last = "2026-09-23T00:20:00.000Z";
  // 10/09 18:30Z の試合が猶予 120h を超えるのは 10/14 18:30Z 以降
  const now = "2026-10-15T00:29:00.000Z";
  // 取込より前 → 対象外（その結果はもう台帳にある）
  assert.equal(ingestDue([ledgerMatch("2026-09-20T14:00:00.000Z")], last, now), null);
  // 取込より後だが猶予の内側 → まだ来ていないだけ
  assert.equal(ingestDue([ledgerMatch("2026-10-09T18:30:00.000Z")], last, "2026-10-10T00:29:00.000Z"), null);
  // 猶予を過ぎた → 最古の 1 件を返す
  // 同じ呼び出しでも、猶予の内側の 10/10 の試合は数えない（1 試合ごとに判定する）
  const due = ingestDue(
    [ledgerMatch("2026-10-10T14:00:00.000Z"), ledgerMatch("2026-10-09T18:30:00.000Z", "D1")],
    last,
    now,
  );
  assert.equal(due?.kickoffAt, "2026-10-09T18:30:00.000Z");
  assert.equal(due?.league, "D1");
  assert.ok((due?.ageHours ?? 0) > RESULT_DUE_HOURS);
  assert.ok((due?.ageHours ?? 0) < RESULT_DUE_HOURS + 12, `${due?.ageHours}`);
  // 結果が 1 件も無い台帳（lastRecordedAt = null）は判断しない
  assert.equal(ingestDue([ledgerMatch("2026-10-09T18:30:00.000Z")], null, now), null);
});

test("ingestDue: 実測した平常運転の取込間隔で誤警報を出さない", () => {
  // 本番台帳の実測（2026-09-25）。健全に動いていた期間にも 96.6h / 127.6h の間隔があり、
  // 猶予 120h ならどの回も「取り込むべき試合」が立たない
  const last = "2026-09-18T00:06:24.135Z";
  const played = [
    ledgerMatch("2026-09-18T20:00:00.000Z", "SP1"),
    ledgerMatch("2026-09-19T15:15:00.000Z", "SP1"),
    ledgerMatch("2026-09-20T17:30:00.000Z", "SP1"),
  ];
  for (const runAt of ["2026-09-19T00:06:00.000Z", "2026-09-20T00:06:00.000Z", "2026-09-21T00:06:00.000Z", "2026-09-22T00:43:00.000Z"]) {
    assert.equal(ingestDue(played, last, runAt), null, `誤警報: ${runAt}`);
    assert.equal(ingestLevel(ingestHealth([result("2026-09-17", last)], runAt), ingestDue(played, last, runAt)), "ok", runAt);
  }
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

/* ── 発行の沈黙（2026-09-22・Founder 承認 1-1） ─────────────────────────────── */

test("0 件の回は「季が動いている」ときだけ数える（国際試合週間で赤くしない）", () => {
  // 事故のとき（2026-09-19）は次のキックオフが 1 日以内にあった → 数える
  assert.equal(seasonLive(["2026-09-19T18:00:00Z"], "2026-09-19T00:04:00Z"), true);
  // 国際試合週間: 直近のキックオフが無い → 数えない
  assert.equal(seasonLive(["2026-09-30T18:00:00Z"], "2026-09-19T00:04:00Z"), false);
  // 過去のキックオフは「これから」ではない
  assert.equal(seasonLive(["2026-09-18T18:00:00Z"], "2026-09-19T00:04:00Z"), false);
  assert.equal(seasonLive([], "2026-09-19T00:04:00Z"), false);
});

test("連続回数: 日程が入れば 0 に戻り、季が動いていない回は据え置く", () => {
  assert.equal(nextZeroFixtureRuns(2, 10, true), 0, "1 件でも入れば解除");
  assert.equal(nextZeroFixtureRuns(2, 0, true), 3, "季が動いていて 0 件なら増える");
  assert.equal(nextZeroFixtureRuns(2, 0, false), 2, "季が動いていなければ据え置き（増やしも減らしもしない）");
  assert.equal(nextZeroFixtureRuns(0, 0, false), 0);
});

test("判定: 0 件が 2 回続いたら赤、1 回は黄", () => {
  const rep = (z: number): RunReport => ({ at: "2026-09-21T00:04:00Z", zeroFixtureRuns: z, leagues: [] });
  assert.equal(publishLevel(rep(0), []).level, "ok");
  assert.equal(publishLevel(rep(1), []).level, "warn");
  assert.equal(publishLevel(rep(2), []).level, "fail", "事故の在季 0 件は 2 回で止まった（3 回だと取り逃がす）");
  assert.equal(publishLevel(rep(ZERO_FIXTURE_FAIL_RUNS), []).reasons.length, 1);
  // 実績の記録が無い台帳（この仕組みより前）は ok
  assert.equal(publishLevel(null, []).level, "ok");
});

test("取りこぼし: 封緘前に登録されていたのに未発行のものだけを数える", () => {
  const m = (providerId: string, recordedAt: string, cutoffAt: string) => ({
    providerId, league: "E0", kickoffAt: "2026-09-20T14:00:00Z", cutoffAt, recordedAt,
  });
  const now = "2026-09-21T00:04:00Z";
  const rows = [
    m("miss", "2026-09-17T00:00:00Z", "2026-09-19T11:00:00Z"), // 封緘前に登録・未発行 → 取りこぼし
    m("late", "2026-09-19T12:00:00Z", "2026-09-19T11:00:00Z"), // 封緘後に初登録 → 対象外
    m("open", "2026-09-17T00:00:00Z", "2026-09-30T11:00:00Z"), // まだ封緘前 → 対象外
    m("done", "2026-09-17T00:00:00Z", "2026-09-19T11:00:00Z"), // 発行済み → 対象外
    m("old", "2026-07-01T00:00:00Z", "2026-07-02T11:00:00Z"),  // 窓の外 → 対象外
  ];
  const got = missedSeals(rows, new Set(["done"]), () => true, now);
  assert.deepEqual(got.map((x) => x.providerId), ["miss"]);
  assert.equal(got[0].predictable, true);
  assert.equal(publishLevel(null, got, "2026-09-01T00:00:00Z").level, "fail", "出せたのに出していない試合があれば赤");
});

test("取りこぼし: 学習データが無いチームは判定に使わない（昇格直後など）", () => {
  const rows = [{
    providerId: "new", league: "E0", kickoffAt: "2026-09-20T14:00:00Z",
    cutoffAt: "2026-09-19T11:00:00Z", recordedAt: "2026-09-17T00:00:00Z",
  }];
  const got = missedSeals(rows, new Set(), () => false, "2026-09-21T00:04:00Z");
  assert.equal(got.length, 1);
  assert.equal(got[0].predictable, false);
  const pub = publishLevel(null, got, "2026-09-01T00:00:00Z");
  assert.equal(pub.level, "ok", "出しようがなかった試合で赤くしない");
  assert.equal(pub.unpredictable.length, 1, "参考としては出す");
});

test("同じ試合の行が複数あるとき、最初の登録時刻で判定する（封緘規則の更新で行が増える）", () => {
  const rows = [
    { providerId: "a", league: "E0", kickoffAt: "2026-09-20T14:00:00Z", cutoffAt: "2026-09-19T11:00:00Z", recordedAt: "2026-09-17T00:00:00Z" },
    { providerId: "a", league: "E0", kickoffAt: "2026-09-20T14:00:00Z", cutoffAt: "2026-09-19T11:00:00Z", recordedAt: "2026-09-19T12:00:00Z" },
  ];
  const got = missedSeals(rows, new Set(), () => true, "2026-09-21T00:04:00Z");
  assert.equal(got.length, 1, "最新行だけ見ると『封緘後に登録』と誤判定する");
  assert.equal(got[0].firstRecordedAt, "2026-09-17T00:00:00Z");
});

test("合計は全リーグを足す", () => {
  const r: RunReport = { at: "x", zeroFixtureRuns: 0, leagues: [
    { league: "E0", fixtures: 10, added: 2, published: 3, deferred: 1, openBeforeCutoff: 5 },
    { league: "I1", fixtures: 8, added: 0, published: 1, deferred: 0, openBeforeCutoff: 4 },
  ] };
  assert.deepEqual(runTotals(r), { fixtures: 18, added: 2, published: 4, deferred: 1, openBeforeCutoff: 9 });
});

test("記録開始日より前の取りこぼしは報告するが赤くしない（導入時に 31 件あった実測）", () => {
  const m = (cutoffAt: string): MissedSeal => ({
    providerId: cutoffAt, league: "E0", kickoffAt: cutoffAt, cutoffAt,
    firstRecordedAt: "2026-09-01T00:00:00Z", predictable: true,
  });
  const start = "2026-09-22T00:00:00Z";
  const old = publishLevel(null, [m("2026-09-13T11:00:00Z")], start);
  assert.equal(old.level, "ok", "過去の分で赤にしない");
  assert.equal(old.missedBeforeStart.length, 1, "参考としては出す");
  const fresh = publishLevel(null, [m("2026-09-23T11:00:00Z")], start);
  assert.equal(fresh.level, "fail", "記録開始日より後の取りこぼしは赤");
  assert.equal(fresh.missed.length, 1);
});
