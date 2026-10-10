/**
 * 2 つ目のモデル（市場基盤・mkt-blend-v1）の不変条件。
 *  1. a=1, b=0, c=0 なら市場そのもの（土台は市場）
 *  2. 係数の推定は、仕込んだ係数を取り戻せる
 *  3. 「得になるか」は最良オッズとの比較でだけ決める。最良オッズが無ければ推奨しない
 *  4. 系統ごとに別ファイルの台帳（日程と結果は共有）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MKT_MODEL, MKT_WEIGHTS, blend, fitBlend, marketModel } from "../src/marketModel.ts";
import { Ledger } from "../src/ledger.ts";
import { parseOddsEvents, type OddsEvent } from "../src/oddsApi.ts";
import { rng } from "../src/subgroups.ts";

test("blend: 係数 (1, 0, 0) は市場そのもの・合計 1", () => {
  assert.equal(MKT_MODEL, "mkt-blend-v1");
  const m: [number, number, number] = [0.6, 0.25, 0.15];
  const q: [number, number, number] = [0.3, 0.3, 0.4];
  const p = blend(m, q, { a: 1, b: 0, c: 0 });
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k]! - m[k]!) < 1e-12);
  const r = blend(m, q, MKT_WEIGHTS);
  assert.ok(Math.abs(r[0] + r[1] + r[2] - 1) < 1e-12);
});

test("fitBlend: 仕込んだ係数（a 1.2・b 0.3・c 0.1）を取り戻す", () => {
  const rand = rng(3);
  const truth = { a: 1.2, b: 0.3, c: 0.1 };
  const rows = Array.from({ length: 20000 }, () => {
    const h = 0.2 + 0.5 * rand();
    const d = 0.2 + 0.1 * rand();
    const m: [number, number, number] = [h, d, 1 - h - d];
    const qh = Math.min(0.85, Math.max(0.05, h + 0.2 * (rand() - 0.5)));
    const q: [number, number, number] = [qh, d, 1 - qh - d];
    const p = blend(m, q, truth);
    const u = rand();
    return { m, q, o: (u < p[0] ? 0 : u < p[0] + p[1] ? 1 : 2) as 0 | 1 | 2 };
  });
  const w = fitBlend(rows);
  assert.ok(Math.abs(w.a - 1.2) < 0.15 && Math.abs(w.b - 0.3) < 0.15 && Math.abs(w.c - 0.1) < 0.1, JSON.stringify(w));
});

test("marketModel: 最良オッズが無ければ推奨しない・あれば EV 最大の正の結果だけ", () => {
  const m: [number, number, number] = [0.6, 0.25, 0.15];
  const w = { a: 1, b: 0, c: 0 };
  assert.equal(marketModel(m, m, null, w).recommend, null);
  assert.equal(marketModel(m, m, null, w).ev, null);
  assert.equal(marketModel(m, m, [1.5, 0, 6], w).ev, null); // 1 以下のオッズは不正
  const pass = marketModel(m, m, [1.5, 3.6, 6.0], w);
  assert.equal(pass.recommend, null);
  assert.ok(pass.ev!.every((e) => e <= 0));
  const { p, ev, recommend } = marketModel(m, m, [1.8, 3.6, 6.0], w);
  assert.equal(recommend, "H");
  assert.ok(Math.abs(ev![0] - (p[0] * 1.8 - 1)) < 1e-12);
});

test("oddsApi: 結果ごとの最良オッズとそのブックを残す", () => {
  const ev: OddsEvent[] = [{
    id: "x", sport_key: "soccer_epl", commence_time: "2026-10-11T14:00:00Z", home_team: "A", away_team: "B",
    bookmakers: [
      { key: "b1", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2.0 }, { name: "Draw", price: 3.5 }, { name: "B", price: 3.6 }] }] },
      { key: "b2", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2.1 }, { name: "Draw", price: 3.3 }, { name: "B", price: 3.8 }] }] },
    ],
  }];
  const [f] = parseOddsEvents(ev);
  assert.deepEqual(f.bestOdds, [2.1, 3.5, 3.8]);
  assert.deepEqual(f.bestBooks, ["b2", "b1", "b2"]);
  const [none] = parseOddsEvents([{ ...ev[0], bookmakers: [] }]);
  assert.equal(none.bestOdds, null);
});

test("台帳の系統: 予想と評価は別ファイル・日程と結果は共有・系統ごとに 1 試合 1 予想", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-track-"));
  const C = new Ledger(dir);
  const M = new Ledger(dir, { track: "mkt" });
  const fx = parseOddsEvents([{
    id: "e1", sport_key: "soccer_epl", commence_time: "2026-09-05T14:00:00Z", home_team: "A", away_team: "B",
    bookmakers: [{ key: "b1", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2 }, { name: "Draw", price: 3.4 }, { name: "B", price: 3.8 }] }] }],
  }], (n) => n);
  C.recordFixtures(fx, "E0", "2026-09-03T01:00:00Z");
  assert.equal(M.currentMatches().size, 1); // 日程は共有
  const base = {
    providerId: "e1", league: "E0", kickoffAt: "2026-09-05T14:00:00Z", publishedAt: "2026-09-03T03:00:00Z", asOf: "2026-09-03T01:00:00Z",
    lambdaHome: 0, lambdaAway: 0, market: fx[0].market, marketFetchedAt: "2026-09-03T01:00:00Z",
  };
  assert.ok(C.publishPrediction({ ...base, model: "dc-v5-shots", nTrain: 900, pHome: 0.5, pDraw: 0.25, pAway: 0.25, lambdaHome: 1.5, lambdaAway: 1 }).ok);
  assert.ok(M.publishPrediction({ ...base, model: MKT_MODEL, nTrain: 0, pHome: 0.52, pDraw: 0.26, pAway: 0.22 }).ok);
  assert.equal((M.publishPrediction({ ...base, model: MKT_MODEL, nTrain: 0, pHome: 0.4, pDraw: 0.3, pAway: 0.3 }) as { ok: boolean }).ok, false);
  assert.ok(existsSync(join(dir, "predictions.mkt.ndjson")));
  assert.equal(C.predictions().length, 1);
  assert.equal(M.predictions().length, 1);
  // 結果は片方で入れれば両方が決済できる
  C.recordResults([{ division: "E0", date: "2026-09-05T14:00:00Z", home: "A", away: "B", homeGoals: 0, awayGoals: 1, odds: null }], "x", "2026-09-06T00:00:00Z");
  assert.equal(C.settle("2026-09-06T00:10:00Z"), 1);
  assert.equal(M.settle("2026-09-06T00:10:00Z"), 1);
  assert.equal(M.evaluations()[0].result, "A");
  assert.equal(C.evaluations().length, 1);
  assert.ok(existsSync(join(dir, "evaluations.mkt.ndjson")));
});

test("最良のオッズ: 取引所（手数料前の価格）は候補から外す・中央値には含める", () => {
  const ev: OddsEvent[] = [{
    id: "x", sport_key: "soccer_epl", commence_time: "2026-10-11T14:00:00Z", home_team: "A", away_team: "B",
    bookmakers: [
      { key: "b1", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2.0 }, { name: "Draw", price: 3.4 }, { name: "B", price: 3.6 }] }] },
      { key: "betfair_ex_eu", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2.3 }, { name: "Draw", price: 3.9 }, { name: "B", price: 4.2 }] }] },
      { key: "matchbook", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2.25 }, { name: "Draw", price: 3.8 }, { name: "B", price: 4.1 }] }] },
    ],
  }];
  const [f] = parseOddsEvents(ev);
  assert.deepEqual(f.bestOdds, [2.0, 3.4, 3.6]);
  assert.deepEqual(f.bestBooks, ["b1", "b1", "b1"]);
  assert.equal(f.bookmakers, 3);
  // 取引所しか無い試合は最良値なし（推奨しない）
  const [only] = parseOddsEvents([{ ...ev[0], bookmakers: ev[0].bookmakers.slice(1) }]);
  assert.equal(only.bestOdds, null);
});

test("marketModel: 最良値の組み合わせで裁定が成立する試合は推奨しない（どれかの価格が古い）", () => {
  const m: [number, number, number] = [0.5, 0.27, 0.23];
  const w = { a: 1, b: 0, c: 0 };
  const arb: [number, number, number] = [2.2, 4.0, 5.0]; // 1/2.2+1/4+1/5 = 0.9045
  const r = marketModel(m, m, arb, w);
  assert.ok(r.ev!.some((e) => e > 0));
  assert.equal(r.recommend, null);
});
