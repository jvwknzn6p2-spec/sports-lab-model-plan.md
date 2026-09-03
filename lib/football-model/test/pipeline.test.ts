import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSummary, selectToPredict, summarizeLeague } from "../src/pipeline.ts";
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction } from "../src/ledger.ts";

const m = (id: string, kickoffAt: string): LedgerMatch => ({ providerId: id, league: "JAP", kickoffAt, cutoffAt: new Date(Date.parse(kickoffAt) - 3_600_000).toISOString(), home: "A", away: "B", recordedAt: "t" });
const now = "2026-09-04T03:00:00Z";

test("selectToPredict: 未発行・封緘前・36h 以内だけ、キックオフ順", () => {
  const ms = [m("late", "2026-09-06T10:00:00Z"), m("soon", "2026-09-04T10:00:00Z"), m("started", "2026-09-04T02:00:00Z"), m("sealed", "2026-09-04T03:30:00Z"), m("done", "2026-09-04T12:00:00Z"), m("tmrw", "2026-09-05T09:00:00Z")];
  const preds = [{ providerId: "done" } as LedgerPrediction];
  assert.deepEqual(selectToPredict(ms, preds, now).map((x) => x.providerId), ["soon", "tmrw"]);
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
