import { test } from "node:test";
import assert from "node:assert/strict";
import { logLoss, multiclassBrier, outcomeOf, rps, summarize, wilson95 } from "../src/scoring.ts";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("rps: 完全な予想は 0・一様予想のホーム勝ちは 5/18", () => {
  assert.equal(rps([1, 0, 0], 0), 0);
  close(rps([1 / 3, 1 / 3, 1 / 3], 0), 5 / 18);
  // 引き分けの一様予想: ((1/3-0)^2 + (2/3-1)^2)/2 = (1/9 + 1/9)/2 = 1/9
  close(rps([1 / 3, 1 / 3, 1 / 3], 1), 1 / 9);
});

test("rps は順序を見る: 90% ホームで引き分け < 90% ホームでアウェイ勝ち", () => {
  const p = [0.9, 0.05, 0.05] as const;
  assert.ok(rps(p, 1) < rps(p, 2));
  // 多値 Brier は順序を見ないので両者は等しい
  close(multiclassBrier(p, 1), multiclassBrier(p, 2));
});

test("multiclassBrier / logLoss の既知解", () => {
  close(multiclassBrier([1 / 3, 1 / 3, 1 / 3], 0), 2 / 3);
  close(logLoss([0.5, 0.3, 0.2], 2), -Math.log(0.2));
  assert.ok(Number.isFinite(logLoss([1, 0, 0], 2)));
});

test("確率が不正なら例外", () => {
  assert.throws(() => rps([0.5, 0.5, 0.5], 0), /合計/);
  assert.throws(() => rps([1.2, -0.2, 0], 0), /合計|外/);
});

test("outcomeOf", () => {
  assert.equal(outcomeOf(2, 1), 0);
  assert.equal(outcomeOf(1, 1), 1);
  assert.equal(outcomeOf(0, 3), 2);
});

test("wilson95: VORTE EV の実測値と同じ（117/181 → [57%, 71%]）", () => {
  const { lo, hi } = wilson95(117, 181);
  assert.equal(Math.round(lo * 100), 57);
  assert.equal(Math.round(hi * 100), 71);
  assert.deepEqual(wilson95(0, 0), { lo: 0, hi: 0 });
});

test("summarize: 件数・的中・平均", () => {
  const s = summarize([
    { p: [0.6, 0.2, 0.2], outcome: 0 },
    { p: [0.2, 0.2, 0.6], outcome: 0 },
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.hits, 1);
  close(s.accuracy, 0.5);
  close(s.meanRps, (rps([0.6, 0.2, 0.2], 0) + rps([0.2, 0.2, 0.6], 0)) / 2);
  assert.ok(Number.isNaN(summarize([]).meanRps));
});
