/**
 * 2 つ目のモデル（市場補正・mkt-flb-v1）の不変条件。
 *  1. 市場確率に γ 補正を掛けるだけ（本命を強め、大穴を弱める）
 *  2. 「得になるか」は最良オッズとの比較でだけ決める。最良オッズが無ければ推奨しない
 *  3. 系統ごとに別ファイルの台帳（日程と結果は共有）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MKT_GAMMA, MKT_MODEL, marketModel } from "../src/marketModel.ts";
import { Ledger } from "../src/ledger.ts";
import { parseOddsEvents, type OddsEvent } from "../src/oddsApi.ts";

test("marketModel: 合計 1・本命を強め大穴を弱める（γ>1）", () => {
  assert.ok(MKT_GAMMA > 1);
  assert.equal(MKT_MODEL, "mkt-flb-v1");
  const m: [number, number, number] = [0.7, 0.18, 0.12];
  const { p } = marketModel(m, null);
  assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-12);
  assert.ok(p[0] > m[0]);
  assert.ok(p[2] < m[2]);
  // 3 等分は動かない（補正は順位を作らない）
  const flat = marketModel([1 / 3, 1 / 3, 1 / 3], null).p;
  for (const x of flat) assert.ok(Math.abs(x - 1 / 3) < 1e-12);
});

test("marketModel: 最良オッズが無ければ推奨しない・あれば EV 最大の正の結果だけ", () => {
  const m: [number, number, number] = [0.6, 0.25, 0.15];
  assert.deepEqual(marketModel(m, null).recommend, null);
  assert.equal(marketModel(m, null).ev, null);
  assert.equal(marketModel(m, [1.5, 0, 6]).ev, null); // 1 以下のオッズは不正
  // 控除の大きいオッズ → 全結果で損 → 見送り
  const pass = marketModel(m, [1.5, 3.6, 6.0]);
  assert.equal(pass.recommend, null);
  assert.ok(pass.ev!.every((e) => e <= 0));
  // ホームに甘いオッズ → ホームを推奨。EV = p × odds − 1
  const { p, ev, recommend } = marketModel(m, [1.8, 3.6, 6.0]);
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
