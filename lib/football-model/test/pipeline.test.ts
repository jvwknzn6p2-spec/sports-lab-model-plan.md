import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSummary, selectToPredict, summarizeLeague } from "../src/pipeline.ts";
import { cutoffOf, type LedgerEvaluation, type LedgerMatch, type LedgerPrediction } from "../src/ledger.ts";

const m = (id: string, kickoffAt: string): LedgerMatch => ({ providerId: id, league: "JAP", kickoffAt, cutoffAt: cutoffOf(kickoffAt), home: "A", away: "B", recordedAt: "t" });
const now = "2026-09-04T03:00:00Z"; // JST 9/4 12:00

test("selectToPredict: 未発行・封緘前（前日 20:00 JST）・48h 以内だけ、キックオフ順", () => {
  const ms = [
    m("late", "2026-09-06T10:00:00Z"), // JST 9/6 19:00・封緘 9/5 20:00 は未来だが 55h 先 → 対象外
    m("soon", "2026-09-04T15:00:00Z"), // JST 9/5 00:00・封緘 9/4 20:00 JST は未来 → 対象
    m("started", "2026-09-04T02:00:00Z"), // 開始済み
    m("sealed", "2026-09-04T10:00:00Z"), // JST 9/4 19:00・封緘 9/3 20:00 JST は経過 → 対象外（当日の試合は当日には出せない）
    m("done", "2026-09-05T12:00:00Z"), // 発行済み
    m("tmrw", "2026-09-05T09:00:00Z"), // JST 9/5 18:00・封緘 9/4 20:00 JST → 対象
    m("dayafter", "2026-09-05T20:00:00Z"), // JST 9/6 05:00（欧州の夜）・封緘 9/5 20:00 JST・41h 先 → 48h 窓で対象（36h では落ちていた）
  ];
  const preds = [{ providerId: "done" } as LedgerPrediction];
  assert.deepEqual(selectToPredict(ms, preds, now).map((x) => x.providerId), ["soon", "tmrw", "dayafter"]);
  assert.deepEqual(selectToPredict(ms, preds, now, 36).map((x) => x.providerId), ["soon", "tmrw"]);
});

test("summarizeLeague / renderSummary: 同一集合で市場と比べ、件数と区間が出る", () => {
  const preds: LedgerPrediction[] = [
    { id: "p1", providerId: "x1", league: "JAP", kickoffAt: "2026-09-05T10:00:00Z", cutoffAt: "", publishedAt: "2026-09-04T03:00:00Z", model: "dc-v1", asOf: "", nTrain: 1, pHome: 0.5, pDraw: 0.3, pAway: 0.2, lambdaHome: 1, lambdaAway: 1, market: [0.45, 0.3, 0.25], marketFetchedAt: "", fingerprint: "" },
    { id: "p2", providerId: "x2", league: "JAP", kickoffAt: "2026-09-05T10:00:00Z", cutoffAt: "", publishedAt: "2026-09-04T03:00:00Z", model: "dc-v1", asOf: "", nTrain: 1, pHome: 0.2, pDraw: 0.3, pAway: 0.5, lambdaHome: 1, lambdaAway: 1, market: null, marketFetchedAt: null, fingerprint: "" },
  ];
  const evals: LedgerEvaluation[] = [
    { predictionId: "p1", providerId: "x1", league: "JAP", result: "H", homeGoals: 1, awayGoals: 0, rps: 0.145, brier: 0.38, logloss: 0.69, marketRps: 0.18, evaluatedAt: "" },
  ];
  const s = summarizeLeague("JAP", preds, evals);
  assert.equal(s.published, 2);
  assert.equal(s.settled, 1);
  assert.ok(s.model && s.market && s.modelOnMarketSet);
  assert.equal(s.model!.hits, 1);
  const md = renderSummary(["JAP"], preds, evals, new Map([["x1", m("x1", "2026-09-05T10:00:00Z")], ["x2", m("x2", "2026-09-05T10:00:00Z")]]), now);
  assert.match(md, /\| J1 \| 2 \| 1 \|/);
  assert.match(md, /1\/1 100\.0% \[\d+–100%\]/);
  assert.ok(md.includes("A 1-0 B"));
  assert.ok(md.includes("A v B")); // 未決着
  assert.ok(md.includes("ベッティング"));
});
