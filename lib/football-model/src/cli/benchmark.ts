/**
 * 固定の基準（football/benchmark/v1）でモデルの能力を年ごとに測る。規則は src/benchmark.ts の冒頭。
 *
 *   node --experimental-strip-types src/cli/benchmark.ts --bench ../../football/benchmark/v1 [--cache preds.ndjson]
 *
 * 出す数字は全て「その年の試合だけ」で計算する。年をまたぐ合算・持ち越しはしない。
 * 台帳には触れない（凍結データを読むだけ）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BENCHMARK, benjaminiHochberg, compareYear, devig, loadBenchmark, outcomeOf, pTwoSided, predictYear, yearOf,
  type BenchPrediction, type Triple,
} from "../benchmark.ts";
import { blend, fitBlend, type BlendWeights } from "../marketModel.ts";
import { adjust, fitGamma } from "../marketResiduals.ts";

const arg = (n: string, f?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const benchDir = arg("bench", "football/benchmark/v1")!;
const cache = arg("cache");
const rows = loadBenchmark(benchDir);

let preds: BenchPrediction[];
if (cache && existsSync(cache)) {
  preds = readFileSync(cache, "utf8").trim().split("\n").map((l) => JSON.parse(l) as BenchPrediction);
} else {
  preds = (["2023", ...BENCHMARK.years] as const).flatMap((y) => predictYear(rows, y));
  if (cache) writeFileSync(cache, preds.map((p) => JSON.stringify(p)).join("\n") + "\n");
}
const allWithOdds = preds.filter((p) => p.odds && p.odds.home > 1 && p.odds.draw > 1 && p.odds.away > 1);
// 2023 は記憶（市場基盤モデルの係数の学習）だけ。採点は 2024 年以降
preds = preds.filter((p) => yearOf(p.date) >= "2024");
const withOdds = preds.filter((p) => p.odds && p.odds.home > 1 && p.odds.draw > 1 && p.odds.away > 1);
const f3 = (x: number) => x.toFixed(4);
const pc = (x: number, d = 1) => (x * 100).toFixed(d);
const sgn = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}`;

console.log(`# モデルの能力（固定の基準 ${BENCHMARK.version}・sha256 ${BENCHMARK.sha256.slice(0, 12)}…・〜${BENCHMARK.until}）`);
console.log("年ごとに独立に計算（その年の試合だけ）。学習は各試合日の 2 日前まで。RPS / Brier / log loss は小さいほど良い。\n");

// ---------------------------------------------------------------------------
console.log("## 1. 正準モデル vs 市場（同じ試合）");
console.log("| 年 | 試合 | RPS モデル / 市場 | 差（t） | Brier モデル / 市場 | log loss モデル / 市場 | 的中率 モデル / 市場 | 較正誤差 モデル / 市場 |");
console.log("|---|---|---|---|---|---|---|---|");
for (const y of BENCHMARK.years) {
  const c = compareYear(y, withOdds.filter((p) => yearOf(p.date) === y).map((p) => ({ date: p.date, a: p.p, b: devig(p.odds!), o: outcomeOf(p) })));
  console.log(`| ${y} | ${c.n} | ${f3(c.a.rps)} / ${f3(c.b.rps)} | ${c.diff >= 0 ? "+" : ""}${f3(c.diff)}（${c.t.toFixed(2)}） | ${f3(c.a.brier)} / ${f3(c.b.brier)} | ${f3(c.a.logloss)} / ${f3(c.b.logloss)} | ${pc(c.a.hit)}% / ${pc(c.b.hit)}% | ${pc(c.a.ece, 2)}pp / ${pc(c.b.ece, 2)}pp |`);
}
console.log(`\n予想できた試合 / 全試合: ${BENCHMARK.years.map((y) => `${y} ${preds.filter((p) => yearOf(p.date) === y).length}/${rows.filter((r) => yearOf(r.date) === y).length}`).join("・")}`);

console.log("\n## 1b. 市場基盤モデル mkt-blend-v1（市場 ＋ 正準の情報）vs 市場（同じ試合）");
console.log("係数（a 市場・b 正準・c 引き分け）は試合日ごとに、その 2 日前までの試合（2023 年〜）だけで当て直す。");
console.log("| 年 | 試合 | RPS 市場基盤 / 市場 | 差（t） | 的中率 市場基盤 / 市場 | 較正誤差 市場基盤 / 市場 | その年の最後の係数 a / b / c |");
console.log("|---|---|---|---|---|---|---|");
{
  const pairs = allWithOdds.map((p) => ({ date: p.date, m: devig(p.odds!), q: p.p, o: outcomeOf(p) })).sort((x, y) => x.date.localeCompare(y.date));
  const out = new Map<string, Triple>();
  const last = new Map<string, BlendWeights>();
  let w: BlendWeights = { a: 1, b: 0, c: 0 };
  let fitFor = "";
  let i0 = 0; // pairs[0..i0) が学習に使える（date ≤ D−2）
  for (let i = 0; i < pairs.length; i++) {
    const x = pairs[i]!;
    if (yearOf(x.date) < "2024") continue;
    if (x.date !== fitFor) {
      const lim = new Date(Date.parse(`${x.date}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
      while (i0 < pairs.length && pairs[i0]!.date <= lim) i0++;
      w = fitBlend(pairs.slice(0, i0), 6);
      fitFor = x.date;
    }
    out.set(`${x.date}|${i}`, blend(x.m, x.q, w) as Triple);
    last.set(yearOf(x.date), w);
  }
  for (const y of BENCHMARK.years) {
    const ys = pairs.map((x, i) => ({ x, i })).filter(({ x }) => yearOf(x.date) === y);
    const c = compareYear(y, ys.map(({ x, i }) => ({ date: x.date, a: out.get(`${x.date}|${i}`)!, b: x.m, o: x.o })));
    const lw = last.get(y)!;
    console.log(`| ${y} | ${c.n} | ${f3(c.a.rps)} / ${f3(c.b.rps)} | ${c.diff >= 0 ? "+" : ""}${f3(c.diff)}（${c.t.toFixed(2)}） | ${pc(c.a.hit)}% / ${pc(c.b.hit)}% | ${pc(c.a.ece, 2)}pp / ${pc(c.b.ece, 2)}pp | ${lw.a.toFixed(3)} / ${lw.b.toFixed(3)} / ${lw.c.toFixed(3)} |`);
  }
  const prod = fitBlend(pairs, 10);
  console.log(`\n本番の係数（基準の全期間 ${pairs.length} 試合で当てた値・未来の試合にだけ使う）: a = ${prod.a.toFixed(4)} / b = ${prod.b.toFixed(4)} / c = ${prod.c.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log("\n## 2. モデルはチームの強さの変化に遅れているか（その年の中だけ）");
console.log("各チームの直前 5 試合（同じ年の中）の「実際の勝ち − 予想の勝率」の平均と、次の試合の同じ量の相関。");
console.log("予想がチームの調子に追いついていれば相関は 0。正なら「直近に予想より勝っているチームを、次も過小評価している」＝遅れ。");
console.log("| 年 | チーム×試合 | モデル: 相関（t）| 直近 5 試合 +15pp 以上のチームの次の試合: 実際 − モデル（件数） | 市場: 相関（t） | 同 実際 − 市場 |");
console.log("|---|---|---|---|---|---|");
for (const y of BENCHMARK.years) {
  const ys = withOdds.filter((p) => yearOf(p.date) === y).sort((a, b) => a.date.localeCompare(b.date));
  const hist = new Map<string, { m: number[]; k: number[] }>();
  const xm: number[] = [];
  const ym: number[] = [];
  const xk: number[] = [];
  const yk: number[] = [];
  let hotM = 0;
  let hotK = 0;
  let hotN = 0;
  for (const p of ys) {
    const o = outcomeOf(p);
    const k = devig(p.odds!);
    for (const [team, kk, win] of [[`${p.league}:${p.home}`, 0, o === 0], [`${p.league}:${p.away}`, 2, o === 2]] as const) {
      const h = hist.get(team) ?? hist.set(team, { m: [], k: [] }).get(team)!;
      const rm = (win ? 1 : 0) - p.p[kk];
      const rk = (win ? 1 : 0) - k[kk];
      if (h.m.length >= 5) {
        const lm = h.m.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const lk = h.k.slice(-5).reduce((a, b) => a + b, 0) / 5;
        xm.push(lm);
        ym.push(rm);
        xk.push(lk);
        yk.push(rk);
        if (lm >= 0.15) {
          hotM += rm;
          hotK += rk;
          hotN++;
        }
      }
      h.m.push(rm);
      h.k.push(rk);
    }
  }
  const cor = (a: number[], b: number[]) => {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < n; i++) {
      sab += (a[i]! - ma) * (b[i]! - mb);
      saa += (a[i]! - ma) ** 2;
      sbb += (b[i]! - mb) ** 2;
    }
    const r = sab / Math.sqrt(saa * sbb);
    return { r, t: (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r) };
  };
  const cm = cor(xm, ym);
  const ck = cor(xk, yk);
  console.log(`| ${y} | ${xm.length} | ${cm.r.toFixed(3)}（${cm.t.toFixed(2)}） | ${sgn(hotM / hotN)}pp（${hotN}） | ${ck.r.toFixed(3)}（${ck.t.toFixed(2)}） | ${sgn(hotK / hotN)}pp |`);
}

// ---------------------------------------------------------------------------
console.log("\n### 2b. モデルと市場の勝率が食い違った試合で、どちらが当たったか（チームの勝ち・その年の中だけ）");
console.log("差 = モデルの勝率 − 市場の勝率。負の行は「市場はそのチームをモデルより高く見ている」試合。");
for (const y of BENCHMARK.years) {
  const ys = withOdds.filter((p) => yearOf(p.date) === y);
  const b: Record<string, { n: number; w: number; m: number; k: number }> = {};
  const lab = (d: number) => (d <= -0.1 ? "a: −10pp 以下" : d <= -0.05 ? "b: −10〜−5pp" : d < 0.05 ? "c: ±5pp 未満" : d < 0.1 ? "d: +5〜+10pp" : "e: +10pp 以上");
  for (const p of ys) {
    const k = devig(p.odds!);
    const o = outcomeOf(p);
    for (const kk of [0, 2] as const) {
      const key = lab(p.p[kk] - k[kk]);
      const c = (b[key] ??= { n: 0, w: 0, m: 0, k: 0 });
      c.n++;
      c.w += o === kk ? 1 : 0;
      c.m += p.p[kk];
      c.k += k[kk];
    }
  }
  console.log(`- **${y}**: ${Object.keys(b).sort().map((key) => { const c = b[key]!; return `${key.slice(3)} ${c.n} 件・実際 ${pc(c.w / c.n)}% / モデル ${pc(c.m / c.n)}% / 市場 ${pc(c.k / c.n)}%`; }).join("　")}`);
}

console.log("\n### 2c. 確率の自信の度合い（その年の試合だけで当てた γ・1 なら自信の度合いが正しい）");
console.log("γ > 1 は「本命をもっと本命と言うべきだった」（控えめすぎ）、γ < 1 は言い過ぎ。");
for (const y of BENCHMARK.years) {
  const ys = withOdds.filter((p) => yearOf(p.date) === y);
  const gm = fitGamma(ys.map((p) => ({ p: p.p, outcome: outcomeOf(p) })));
  const gk = fitGamma(ys.map((p) => ({ p: devig(p.odds!), outcome: outcomeOf(p) })));
  console.log(`- ${y}: モデル γ = ${gm.toFixed(3)} / 市場 γ = ${gk.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log("\n## 3. 市場が「このチームが勝つ」と予想した試合で、市場が自分の確率以上に当てているチーム（その年の中だけ）");
console.log("市場の本命がそのチームだった試合だけを集め、実際の勝ち数と市場の確率の合計を比べる。");
console.log("期待値は「その年の全試合で当てた本命・大穴の偏り（γ）」で補正した市場の確率（どの本命も少し多めに勝つ分を差し引く）。");
console.log("1 年に 100 以上のチームを調べるので、偶然の当たりを除くため Benjamini–Hochberg（偽発見率 10%）を通ったものだけを「検出」とする。\n");
for (const y of BENCHMARK.years) {
  const ys = withOdds.filter((p) => yearOf(p.date) === y);
  const gamma = fitGamma(ys.map((p) => ({ p: devig(p.odds!), outcome: outcomeOf(p) })));
  const cells = new Map<string, { n: number; w: number; e: number; v: number; eRaw: number; mw: number; me: number; mv: number }>();
  for (const p of ys) {
    const raw = devig(p.odds!);
    const adj = adjust(raw, 0, { gamma, b: 0 });
    const fav = raw[0] >= raw[2] ? 0 : 2;
    if (raw[1] > raw[fav]) continue; // 本命が引き分けの試合は除く
    const team = `${p.league}:${fav === 0 ? p.home : p.away}`;
    const c = cells.get(team) ?? cells.set(team, { n: 0, w: 0, e: 0, v: 0, eRaw: 0, mw: 0, me: 0, mv: 0 }).get(team)!;
    const won = outcomeOf(p) === fav ? 1 : 0;
    c.n++;
    c.w += won;
    c.e += adj[fav]!;
    c.v += adj[fav]! * (1 - adj[fav]!);
    c.eRaw += raw[fav]!;
    c.me += p.p[fav]!;
    c.mv += p.p[fav]! * (1 - p.p[fav]!);
  }
  const list = [...cells.entries()].filter(([, c]) => c.n >= 8).map(([k, c]) => ({ k, ...c, z: (c.w - c.e) / Math.sqrt(c.v), zm: (c.w - c.me) / Math.sqrt(c.mv) }));
  const sig = benjaminiHochberg(list.map((x) => pTwoSided(x.z)), 0.1);
  const sigM = benjaminiHochberg(list.map((x) => pTwoSided(x.zm)), 0.1);
  const found = list.filter((_, i) => sig[i]);
  const foundM = list.filter((_, i) => sigM[i]);
  console.log(`### ${y} 年（γ = ${gamma.toFixed(3)}・本命になった試合が 8 以上のチーム ${list.length}）`);
  console.log(`- 検出（市場）: ${found.length ? found.map((x) => `${x.k} ${x.w}/${x.n} 勝・市場 ${pc(x.e / x.n)}%（z ${x.z.toFixed(2)}）`).join("、") : "なし"}`);
  console.log(`- 検出（同じ試合でモデル）: ${foundM.length ? foundM.map((x) => `${x.k} ${x.w}/${x.n} 勝・モデル ${pc(x.me / x.n)}%（z ${x.zm.toFixed(2)}）`).join("、") : "なし"}`);
  console.log("- 参考: z が大きい順の上位 5（**検出ではない**。偶然でもこの程度は出る）");
  console.log("  | チーム | 本命の試合 | 実際の勝率 | 市場（補正前 → 補正後） | z | モデル | z（モデル） |");
  console.log("  |---|---|---|---|---|---|---|");
  for (const x of [...list].sort((a, b) => b.z - a.z).slice(0, 5))
    console.log(`  | ${x.k} | ${x.n} | ${pc(x.w / x.n)}% | ${pc(x.eRaw / x.n)}% → ${pc(x.e / x.n)}% | ${x.z.toFixed(2)} | ${pc(x.me / x.n)}% | ${x.zm.toFixed(2)} |`);
  console.log("");
}
