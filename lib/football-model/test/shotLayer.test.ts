/**
 * 枠内シュート層（`dc-v5-shots`・2026-09-22）。
 *
 * 固定するのは 3 つ:
 *   1. **層が使えないときは得点だけのモデルと 1 ビットも変わらない**（フェイルクローズ）
 *   2. **決定率は学習データの中だけ**から計算する（未来を混ぜない）
 *   3. 層を使ったかどうかが呼び出し側から分かる（台帳に残すため）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitDixonColes, fitShotLayer, predictMatch, predictWithShots, type MatchRecord } from "../src/fit.ts";

/** 決定的な合成リーグ。得点と枠内シュートの関係を意図的に作る */
function league(n: number, withSot: boolean): MatchRecord[] {
  const teams = ["A", "B", "C", "D"];
  const out: MatchRecord[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) {
    const h = teams[i % 4];
    const a = teams[(i + 1 + (i % 3)) % 4];
    if (h === a) continue;
    const hg = Math.floor(rnd() * 4);
    const ag = Math.floor(rnd() * 3);
    out.push({
      date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      home: h, away: a, homeGoals: hg, awayGoals: ag,
      ...(withSot ? { homeSot: hg + 2, awaySot: ag + 2 } : {}),
    });
  }
  return out;
}

test("θ=0 なら層を作らない（本番を 0 にすれば dc-v3-decay と同値）", () => {
  const l = fitShotLayer(league(200, true), 0, { ridge: 2, xi: 0.002 }, 50);
  assert.equal(l.fit, null);
  assert.equal(l.weight, 0);
});

test("枠内シュートが足りなければ層を作らない（推測で埋めない）", () => {
  const noSot = fitShotLayer(league(200, false), 0.25, { ridge: 2, xi: 0.002 }, 50);
  assert.equal(noSot.fit, null, "枠内シュートが 1 件も無いのに層を作っている");
  // 件数が最低数に届かない場合も作らない
  const few = fitShotLayer(league(200, true), 0.25, { ridge: 2, xi: 0.002 }, 500);
  assert.equal(few.fit, null);
});

test("層が無ければ得点だけのモデルと完全に一致する（フェイルクローズ）", () => {
  const train = league(300, false);
  const fit = fitDixonColes(train, { ridge: 2, xi: 0.002 });
  const layer = fitShotLayer(train, 0.25, { ridge: 2, xi: 0.002 }, 50);
  const a = predictMatch(fit, "A", "B");
  const b = predictWithShots(fit, layer, "A", "B");
  assert.equal(b.usedShots, false);
  assert.equal(b.lambda, a.lambda, "λ が一致しない");
  assert.equal(b.mu, a.mu, "μ が一致しない");
  assert.deepEqual([b.outcome.home, b.outcome.draw, b.outcome.away], [a.outcome.home, a.outcome.draw, a.outcome.away]);
});

test("層があれば確率が動き、1 に正規化されている", () => {
  const train = league(300, true);
  const fit = fitDixonColes(train, { ridge: 2, xi: 0.002 });
  const layer = fitShotLayer(train, 0.25, { ridge: 2, xi: 0.002 }, 50);
  assert.ok(layer.fit, "層が作られていない");
  const a = predictMatch(fit, "A", "B");
  const b = predictWithShots(fit, layer, "A", "B");
  assert.equal(b.usedShots, true, "層を使ったことが呼び出し側に伝わっていない");
  assert.notEqual(b.lambda, a.lambda, "層を入れても λ が動いていない");
  const s = b.outcome.home + b.outcome.draw + b.outcome.away;
  assert.ok(Math.abs(s - 1) < 1e-9, `合計が 1 でない: ${s}`);
});

test("決定率は学習データだけから出す（得点合計 / 枠内シュート合計）", () => {
  const train = league(300, true);
  const layer = fitShotLayer(train, 0.25, { ridge: 2, xi: 0.002 }, 50);
  const goals = train.reduce((x, m) => x + m.homeGoals + m.awayGoals, 0);
  const sot = train.reduce((x, m) => x + (m.homeSot as number) + (m.awaySot as number), 0);
  assert.ok(Math.abs(layer.conversion - goals / sot) < 1e-12);
  // 学習に渡していない試合を足しても決定率は変わらない（未来を混ぜていない）
  const layer2 = fitShotLayer(train, 0.25, { ridge: 2, xi: 0.002 }, 50);
  assert.equal(layer2.conversion, layer.conversion);
});

test("片方のチームが層に無ければ得点だけのモデルへ落ちる", () => {
  const train = league(300, true);
  const fit = fitDixonColes([...train, { date: "2025-12-31T00:00:00Z", home: "A", away: "Z", homeGoals: 1, awayGoals: 0 }], { ridge: 2, xi: 0.002 });
  const layer = fitShotLayer(train, 0.25, { ridge: 2, xi: 0.002 }, 50); // Z は層に入っていない
  const b = predictWithShots(fit, layer, "A", "Z");
  assert.equal(b.usedShots, false);
  assert.equal(b.lambda, predictMatch(fit, "A", "Z").lambda);
});
