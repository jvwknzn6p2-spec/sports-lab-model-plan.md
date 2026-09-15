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

// --- 正則化（リッジ縮小）--------------------------------------------------
// 2026-09-15 の実測: 正則化が無いため λ が 0.025〜4.835 まで発散し、
// 「最小確率 1%」のような予想が 168 件中 7 件出ていた。市場との乖離が大きい群ほど
// 成績が悪く（20pt 以上の 16 件で RPS +0.0523）、乖離はエッジではなく雑音だった。
// 対策は攻撃力・守備力を**リーグ平均へ**縮小する L2 罰則（階層ベイズの MAP 近似）。

/** 昇格直後を模す: 既存 6 チームに、数試合しか無く大勝続きの新チーム G を足す */
function withThinTeam(): MatchRecord[] {
  const base = simulate(3, 11);
  const last = Date.parse(base[base.length - 1].date);
  const out = [...base];
  for (let i = 0; i < 4; i++) {
    const date = new Date(last + (i + 1) * 86_400_000).toISOString();
    out.push({ date, home: "G", away: "F", homeGoals: 5, awayGoals: 0 });
  }
  return out;
}

test("ridge 既定 0 は従来の推定と 1 ビット同一（本番の挙動を黙って変えない）", () => {
  const matches = simulate(4, 3);
  const a = fitDixonColes(matches);
  const b = fitDixonColes(matches, { ridge: 0 });
  assert.equal(a.logLikelihood, b.logLikelihood);
  assert.equal(a.homeAdvantage, b.homeAdvantage);
  assert.equal(a.rho, b.rho);
  for (const t of a.teams) {
    assert.equal(a.attack[t], b.attack[t], `attack ${t}`);
    assert.equal(a.defense[t], b.defense[t], `defense ${t}`);
  }
  assert.equal(a.ridge, 0);
});

test("ridge は 0 ではなくリーグ平均へ縮小する（得点水準を下げない）", () => {
  const matches = simulate(4, 5);
  const plain = fitDixonColes(matches, { ridge: 0 });
  const reg = fitDixonColes(matches, { ridge: 20 });
  const mean = (f: typeof plain, k: "attack" | "defense") =>
    f.teams.reduce((s, t) => s + f[k][t], 0) / f.teams.length;
  // 守備力の平均（＝リーグ全体の失点水準）は保たれる。0 へ縮小していたらここが 0 に寄る
  assert.ok(
    Math.abs(mean(reg, "defense") - mean(plain, "defense")) < 0.08,
    `守備力の平均が動いた: ${mean(plain, "defense")} → ${mean(reg, "defense")}`,
  );
  // 平均的な対戦の総得点も保たれる
  const total = (f: typeof plain) => {
    const p = predictMatch(f, "C", "D");
    return p.lambda + p.mu;
  };
  assert.ok(Math.abs(total(reg) - total(plain)) < 0.35, `総得点が動いた: ${total(plain)} → ${total(reg)}`);
});

test("ridge を上げるとチーム間のばらつきが単調に縮む", () => {
  const matches = simulate(4, 9);
  const spread = (ridge: number) => {
    const f = fitDixonColes(matches, { ridge });
    const m = f.teams.reduce((s, t) => s + f.attack[t], 0) / f.teams.length;
    return Math.sqrt(f.teams.reduce((s, t) => s + (f.attack[t] - m) ** 2, 0) / f.teams.length);
  };
  const s = [0, 5, 20, 80].map(spread);
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i] < s[i - 1], `ridge を上げてばらつきが縮まない: ${s.join(" > ")}`);
  }
});

test("標本の薄いチームほど強く縮む（部分プーリング）", () => {
  const matches = withThinTeam();
  const plain = fitDixonColes(matches, { ridge: 0 });
  const reg = fitDixonColes(matches, { ridge: 20 });
  // G は 4 試合しかないのに大勝続き → 正則化なしでは攻撃力が突出する
  const shrinkG = Math.abs(plain.attack.G) - Math.abs(reg.attack.G);
  // 十分な試合数がある既存チームの縮小量と比べる
  const shrinkEstablished =
    ["A", "B", "C", "D", "E", "F"].reduce(
      (s, t) => s + (Math.abs(plain.attack[t]) - Math.abs(reg.attack[t])),
      0,
    ) / 6;
  assert.ok(shrinkG > 0, `G が縮んでいない: ${plain.attack.G} → ${reg.attack.G}`);
  assert.ok(
    shrinkG > shrinkEstablished,
    `薄い標本の G より既存チームの方が縮んだ: G ${shrinkG} vs 既存平均 ${shrinkEstablished}`,
  );
});

test("ridge は極端な期待得点を抑える", () => {
  const matches = withThinTeam();
  const plain = predictMatch(fitDixonColes(matches, { ridge: 0 }), "G", "F");
  const reg = predictMatch(fitDixonColes(matches, { ridge: 20 }), "G", "F");
  assert.ok(plain.lambda > reg.lambda, `正則化で λ が下がっていない: ${plain.lambda} → ${reg.lambda}`);
  // アウェイ勝ちの確率が現実的な下限を割らない（実測で 1% の予想が出ていた）
  assert.ok(reg.outcome.away > plain.outcome.away, `弱い側の確率が上がっていない`);
});

test("リーク検査: ridge を入れても asOf より後の試合は 1 ビットも影響しない", () => {
  const all = simulate(4, 21);
  const asOf = all[Math.floor(all.length * 0.6)].date;
  const a = fitDixonColes(all, { asOf, ridge: 20 });
  const b = fitDixonColes(all.slice(0, Math.floor(all.length * 0.6)), { asOf, ridge: 20 });
  assert.equal(a.logLikelihood, b.logLikelihood);
  for (const t of a.teams) assert.equal(a.attack[t], b.attack[t], `attack ${t}`);
});

test("clampLambda: 既定は無効、指定すると期待得点が範囲に収まり発動が分かる", () => {
  const fit = fitDixonColes(withThinTeam(), { ridge: 0 });
  const off = predictMatch(fit, "G", "F");
  assert.equal(off.clamped, false);
  const on = predictMatch(fit, "G", "F", { clampLambda: [0.15, 2.0] });
  assert.ok(on.lambda <= 2.0 + 1e-12, `λ がクリップされていない: ${on.lambda}`);
  assert.equal(on.clamped, true);
  // 確率は合計 1 のまま
  const s = on.outcome.home + on.outcome.draw + on.outcome.away;
  assert.ok(Math.abs(s - 1) < 1e-9, `確率の合計が 1 でない: ${s}`);
});
