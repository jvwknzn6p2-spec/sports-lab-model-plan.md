/**
 * CLV。**エッジを主張していない予想を母数に入れない**ことと、
 * **市場が片方でも欠けたら推測で埋めずに対象外にする**ことを固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clvEntries, summarizeClv } from "../src/clv.ts";
import type { ClosingMarketResolver } from "../src/marketSnapshots.ts";
import type { LedgerEvaluation, LedgerPrediction } from "../src/ledger.ts";
import type { ProbabilityTriple } from "../src/scoring.ts";

const pred = (id: string, model: ProbabilityTriple, market: ProbabilityTriple | null): LedgerPrediction => ({
  id, providerId: `p-${id}`, league: "E0", kickoffAt: "2026-09-19T18:00:00Z", cutoffAt: "2026-09-18T11:00:00Z",
  publishedAt: "2026-09-17T00:00:00Z", model: "dc-v2-ridge", asOf: "2026-09-17T00:00:00Z", nTrain: 900,
  pHome: model[0], pDraw: model[1], pAway: model[2], lambdaHome: 1.4, lambdaAway: 1.1,
  market, marketFetchedAt: market ? "2026-09-17T00:00:00Z" : null, fingerprint: id,
});

const settled = (id: string): LedgerEvaluation => ({
  predictionId: id, providerId: `p-${id}`, league: "E0", result: "H", homeGoals: 1, awayGoals: 0,
  rps: 0.1, brier: 0.2, logloss: 0.5, marketRps: 0.1, evaluatedAt: "2026-09-20T00:00:00Z",
});

const resolver = (m: Record<string, ProbabilityTriple>): ClosingMarketResolver =>
  (providerId) => (m[providerId] ? { fetchedAt: "2026-09-19T12:00:00Z", market: m[providerId] } : null);

test("モデルが市場より高く見た側の市場の動きを pp で返す", () => {
  // モデル ホーム 50% 対 市場 40% → side=0・edge +10pp。直前は 45% なので move +5pp
  const e = clvEntries([pred("a", [0.5, 0.25, 0.25], [0.4, 0.3, 0.3])], [settled("a")],
    resolver({ "p-a": [0.45, 0.28, 0.27] }));
  assert.equal(e.length, 1);
  assert.equal(e[0].side, 0);
  assert.ok(Math.abs(e[0].edgePp - 10) < 1e-9, `${e[0].edgePp}`);
  assert.ok(Math.abs(e[0].movePp - 5) < 1e-9, `${e[0].movePp}`);
  assert.equal(e[0].closingFetchedAt, "2026-09-19T12:00:00Z");
});

test("最もエッジの大きい側を選ぶ（引き分け・アウェイでも）", () => {
  const e = clvEntries([pred("a", [0.30, 0.40, 0.30], [0.35, 0.25, 0.40])], [settled("a")],
    resolver({ "p-a": [0.34, 0.27, 0.39] }));
  assert.equal(e[0].side, 1, "引き分けが最大エッジ(+15pp)");
  assert.ok(Math.abs(e[0].movePp - 2) < 1e-9);
});

test("市場が欠けている・直前が無い・未決済は対象外（推測で埋めない）", () => {
  const preds = [
    pred("noMarket", [0.5, 0.25, 0.25], null),
    pred("noClosing", [0.5, 0.25, 0.25], [0.4, 0.3, 0.3]),
    pred("unsettled", [0.5, 0.25, 0.25], [0.4, 0.3, 0.3]),
  ];
  const e = clvEntries(preds, [settled("noMarket"), settled("noClosing")],
    resolver({ "p-unsettled": [0.45, 0.28, 0.27] }));
  assert.deepEqual(e.map((x) => x.predictionId), []);
});

test("エッジを主張していない予想は母数に入れない（全ての結果で市場以下）", () => {
  // モデルが市場と完全一致 → どの結果でも差 0 → 対象外
  const e = clvEntries([pred("flat", [0.4, 0.3, 0.3], [0.4, 0.3, 0.3])], [settled("flat")],
    resolver({ "p-flat": [0.45, 0.28, 0.27] }));
  assert.equal(e.length, 0);
});

test("summarize: 平均・t・正方向の割合を Wilson 区間つきで返す", () => {
  const mk = (id: string, move: number) => {
    const market: ProbabilityTriple = [0.4, 0.3, 0.3];
    const closing: ProbabilityTriple = [0.4 + move / 100, 0.3, 0.3 - move / 100];
    return { p: pred(id, [0.5, 0.25, 0.25], market), e: settled(id), closing };
  };
  const rows = [mk("a", 4), mk("b", 2), mk("c", -2), mk("d", 0)];
  const entries = clvEntries(rows.map((r) => r.p), rows.map((r) => r.e),
    resolver(Object.fromEntries(rows.map((r) => [r.p.providerId, r.closing]))));
  const s = summarizeClv(entries);
  assert.equal(s.n, 4);
  assert.ok(Math.abs(s.meanMovePp - 1) < 1e-9, `${s.meanMovePp}`);
  assert.equal(s.positive, 2, "0 は正方向に数えない");
  assert.equal(s.positiveRate, 0.5);
  assert.ok(s.positiveCi.lo < 0.5 && s.positiveCi.hi > 0.5);
  assert.ok(Math.abs(s.meanEdgePp - 10) < 1e-9);
  assert.ok(s.t > 0 && Number.isFinite(s.t));
});

test("summarize: 0 件・1 件で t を捏造しない", () => {
  assert.deepEqual(summarizeClv([]), { n: 0, meanMovePp: 0, sePp: 0, t: 0, positive: 0, positiveRate: 0, positiveCi: { lo: 0, hi: 0 }, meanEdgePp: 0 });
  const one = clvEntries([pred("a", [0.5, 0.25, 0.25], [0.4, 0.3, 0.3])], [settled("a")],
    resolver({ "p-a": [0.45, 0.28, 0.27] }));
  const s = summarizeClv(one);
  assert.equal(s.n, 1);
  assert.equal(s.t, 0, "n=1 で t を出さない");
  assert.equal(s.sePp, 0);
});
