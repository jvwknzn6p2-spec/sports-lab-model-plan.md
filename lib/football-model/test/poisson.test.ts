/**
 * スコア分布の既知解。
 * λ = μ = 1・ρ = 0 の引き分け確率は e^-2 Σ 1/(k!)^2 = e^-2 I0(2) ≈ 0.30850 など、
 * 手計算できる値で行列が正しいことを固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bothTeamsScore,
  dixonColesTau,
  expectedGoals,
  outcomeProbabilities,
  overTotal,
  poissonPmf,
  scoreMatrix,
  topScorelines,
} from "../src/poisson.ts";

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b} (eps ${eps})`);

test("poissonPmf: 既知の値", () => {
  close(poissonPmf(0, 1), Math.exp(-1));
  close(poissonPmf(2, 1.5), Math.exp(-1.5) * 1.5 ** 2 / 2);
  close(poissonPmf(10, 3), Math.exp(-3) * 3 ** 10 / 3628800);
  assert.equal(poissonPmf(-1, 1), 0);
  assert.equal(poissonPmf(0, 0), 1);
});

test("scoreMatrix: 合計 1・対称な相手なら W = L", () => {
  const m = scoreMatrix(1.3, 1.3);
  const total = m.flat().reduce((s, x) => s + x, 0);
  close(total, 1, 1e-9);
  const o = outcomeProbabilities(m);
  close(o.home, o.away, 1e-9);
  close(o.home + o.draw + o.away, 1, 1e-9);
});

test("scoreMatrix: λ = μ = 1・ρ = 0 の引き分け確率は e^-2 I0(2)", () => {
  const m = scoreMatrix(1, 1, { maxGoals: 20 });
  // I0(2) = Σ (1/k!)^2 = 2.2795853...
  close(outcomeProbabilities(m).draw, Math.exp(-2) * 2.2795853023360673, 1e-6);
});

test("ρ < 0（実データの典型）は 0-0 と 1-1 を増やし、1-0 と 0-1 を減らす", () => {
  const base = scoreMatrix(1.4, 1.1);
  const dc = scoreMatrix(1.4, 1.1, { rho: -0.1 });
  assert.ok(dc[0][0] > base[0][0]);
  assert.ok(dc[1][1] > base[1][1]);
  assert.ok(dc[1][0] < base[1][0]);
  assert.ok(dc[0][1] < base[0][1]);
  // 2-0 のような高得点マスは τ = 1 なので、再正規化ぶんしか動かない
  close(dc[2][0] / base[2][0], dc[3][1] / base[3][1], 1e-9);
});

test("dixonColesTau: ρ = 0 なら常に 1", () => {
  for (const [h, a] of [[0, 0], [1, 0], [0, 1], [1, 1], [2, 2]]) {
    assert.equal(dixonColesTau(h, a, 1.5, 1.2, 0), 1);
  }
  close(dixonColesTau(0, 0, 1.5, 1.2, -0.1), 1 + 1.5 * 1.2 * 0.1);
});

test("topScorelines: 高い順・件数・確率の一致", () => {
  const m = scoreMatrix(1.6, 0.9);
  const top = topScorelines(m, 5);
  assert.equal(top.length, 5);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].probability >= top[i].probability);
  assert.deepEqual({ h: top[0].home, a: top[0].away }, { h: 1, a: 0 });
  close(top[0].probability, m[1][0]);
});

test("expectedGoals: 打ち切りが十分なら λ, μ とほぼ一致", () => {
  const m = scoreMatrix(1.7, 1.2, { maxGoals: 15 });
  const xg = expectedGoals(m);
  close(xg.home, 1.7, 1e-4);
  close(xg.away, 1.2, 1e-4);
});

test("bothTeamsScore / overTotal: 定義どおり", () => {
  const m = scoreMatrix(1.5, 1.0);
  close(bothTeamsScore(m), (1 - Math.exp(-1.5)) * (1 - Math.exp(-1.0)), 1e-6);
  let under = 0;
  for (let h = 0; h <= 2; h++) for (let a = 0; a <= 2 - h; a++) under += m[h][a];
  close(overTotal(m, 2.5), 1 - under, 1e-9);
});

test("λ, μ が正でなければ例外", () => {
  assert.throws(() => scoreMatrix(0, 1), /正/);
  assert.throws(() => scoreMatrix(1, -1), /正/);
});
