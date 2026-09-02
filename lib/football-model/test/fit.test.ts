/**
 * 最尤推定の検証。
 * 既知のパラメータから決定的な乱数で試合を生成し、推定がそれを回収することと、
 * asOf より後の試合が 1 ビットも結果に影響しないこと（リーク検査）を固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitDixonColes, predictMatch } from "../src/fit.ts";
import type { MatchRecord } from "../src/fit.ts";
import { walkForward } from "../src/evaluate.ts";

/** 決定的な乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Poisson(λ) の乱数（Knuth） */
function poisson(lambda: number, u: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= u();
  } while (p > L);
  return k - 1;
}

const TRUE = {
  attack: { A: 0.35, B: 0.2, C: 0.05, D: -0.05, E: -0.2, F: -0.35 } as Record<string, number>,
  defense: { A: -0.2, B: 0.0, C: 0.1, D: 0.05, E: 0.1, F: 0.25 } as Record<string, number>,
  gamma: 0.3,
  rho: -0.1,
};

/** 総当たり × seasons 回。1 日 3 試合ずつ進める */
function simulate(seasons: number, seed: number, rho = TRUE.rho): MatchRecord[] {
  const u = rng(seed);
  const teams = Object.keys(TRUE.attack);
  const out: MatchRecord[] = [];
  let day = 0;
  for (let s = 0; s < seasons; s++) {
    for (const home of teams) {
      for (const away of teams) {
        if (home === away) continue;
        const lambda = Math.exp(TRUE.attack[home] + TRUE.defense[away] + TRUE.gamma);
        const mu = Math.exp(TRUE.attack[away] + TRUE.defense[home]);
        // τ 補正は棄却サンプリングで反映する
        let h: number;
        let a: number;
        for (;;) {
          h = poisson(lambda, u);
          a = poisson(mu, u);
          const tau =
            h === 0 && a === 0 ? 1 - lambda * mu * rho
            : h === 1 && a === 0 ? 1 + mu * rho
            : h === 0 && a === 1 ? 1 + lambda * rho
            : h === 1 && a === 1 ? 1 - rho
            : 1;
          if (u() * 1.5 < tau) break;
        }
        const date = new Date(Date.UTC(2025, 0, 1) + Math.floor(day / 3) * 86_400_000).toISOString();
        out.push({ date, home, away, homeGoals: h, awayGoals: a });
        day++;
      }
    }
  }
  return out;
}

test("推定が既知のパラメータを回収する（ξ = 0・10 季）", () => {
  const matches = simulate(10, 42);
  const fit = fitDixonColes(matches, { xi: 0 });
  assert.ok(fit.iterations > 0 && fit.iterations < 3000, `収束せず iterations=${fit.iterations}`);
  assert.ok(Math.abs(fit.homeAdvantage - TRUE.gamma) < 0.1, `γ̂=${fit.homeAdvantage}`);
  assert.ok(Math.abs(fit.rho - TRUE.rho) < 0.08, `ρ̂=${fit.rho}`);
  // 攻撃力・守備力が真値の近くに戻る（300 試合の標本誤差は ±0.1 程度）
  for (const t of fit.teams) {
    assert.ok(Math.abs(fit.attack[t] - TRUE.attack[t]) < 0.15, `attack ${t}: ${fit.attack[t]} vs ${TRUE.attack[t]}`);
  }
  // 最強と最弱 2 チームは順位が保たれる（E と F の差 0.15 は標本誤差と同程度なので順序は問わない）
  const order = [...fit.teams].sort((x, y) => fit.attack[y] - fit.attack[x]);
  assert.equal(order[0], "A");
  assert.deepEqual(new Set(order.slice(-2)), new Set(["E", "F"]));
  // Σ attack = 0
  assert.ok(Math.abs(fit.teams.reduce((s, t) => s + fit.attack[t], 0)) < 1e-9);
});

test("fitRho=false なら ρ = 0 のまま", () => {
  const fit = fitDixonColes(simulate(3, 7), { fitRho: false });
  assert.equal(fit.rho, 0);
});

test("リーク検査: asOf より後の試合を足しても推定が 1 ビットも変わらない", () => {
  const matches = simulate(4, 3);
  const asOf = matches[Math.floor(matches.length / 2)].date;
  const before = matches.filter((m) => Date.parse(m.date) < Date.parse(asOf));
  const a = fitDixonColes(before, { asOf });
  const b = fitDixonColes(matches, { asOf });
  assert.deepEqual(a, b);
  assert.equal(a.nMatches, before.length);
  // asOf ちょうどの試合は「未開始」として除外される
  const c = fitDixonColes([...before, { ...matches[0], date: asOf }], { asOf });
  assert.equal(c.nMatches, before.length);
});

test("時間減衰: 古い試合ほど重みが軽い（ξ を上げると直近の形が強く出る）", () => {
  const matches = simulate(4, 11);
  // 最後の 1 季だけ A を極端に弱くする
  const n = matches.length;
  const bent = matches.map((m, i) =>
    i >= (n * 3) / 4 && m.home === "A" ? { ...m, homeGoals: 0, awayGoals: 4 } : m,
  );
  const slow = fitDixonColes(bent, { xi: 0 });
  const fast = fitDixonColes(bent, { xi: 0.05 });
  assert.ok(fast.attack.A < slow.attack.A, `fast=${fast.attack.A} slow=${slow.attack.A}`);
});

test("predictMatch: 確率の合計 1・強いホームが有利・未知チームは例外", () => {
  const fit = fitDixonColes(simulate(6, 5), { xi: 0 });
  const p = predictMatch(fit, "A", "F");
  assert.ok(Math.abs(p.outcome.home + p.outcome.draw + p.outcome.away - 1) < 1e-9);
  assert.ok(p.outcome.home > 0.6, `A vs F home=${p.outcome.home}`);
  assert.ok(p.lambda > p.mu);
  assert.equal(p.scorelines.length, 5);
  assert.ok(p.expectedGoals.home > p.expectedGoals.away);
  assert.throws(() => predictMatch(fit, "A", "Z"), /未知/);
});

test("入力の検査: 試合なし・非整数の得点・不正な日付", () => {
  assert.throws(() => fitDixonColes([]), /無い/);
  assert.throws(
    () => fitDixonColes([{ date: "2025-01-01T00:00:00Z", home: "A", away: "B", homeGoals: 1.5, awayGoals: 0 }]),
    /整数/,
  );
  assert.throws(
    () => fitDixonColes([{ date: "not-a-date", home: "A", away: "B", homeGoals: 1, awayGoals: 0 }]),
    /date/,
  );
});

test("walkForward: 基準（頻度）より RPS が良い・行数と再学習回数", () => {
  const matches = simulate(8, 21);
  const r = walkForward(matches, { warmup: 60, xi: 0 });
  assert.equal(r.rows.length, r.model.n);
  assert.ok(r.model.n > 100);
  assert.ok(r.refits > 10);
  assert.ok(r.model.meanRps < r.baseline.meanRps, `model=${r.model.meanRps} base=${r.baseline.meanRps}`);
  assert.ok(r.model.meanLogLoss < r.baseline.meanLogLoss);
  // 学習に使った試合は評価に入らない（warmup 前の試合は rows に無い）
  const firstEvaluated = Date.parse(r.rows[0].match.date);
  const trainBefore = matches.filter((m) => Date.parse(m.date) < firstEvaluated).length;
  assert.ok(trainBefore >= 60);
});
