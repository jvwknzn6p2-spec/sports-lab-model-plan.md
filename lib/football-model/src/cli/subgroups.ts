/**
 * 市場が「特定のチーム・条件」に限って系統的に外していないかを、全ての切り口で測る（2026-10-09）。
 * 規則は src/subgroups.ts の冒頭（結果を見る前に固定）。台帳には触れない（履歴を読むだけ）。
 *
 *   node --experimental-strip-types src/cli/subgroups.ts --history ../../football/history
 */
import { readdirSync, readFileSync } from "node:fs";
import { readHistory } from "../history.ts";
import { fitGamma } from "../marketResiduals.ts";
import {
  group, heterogeneity, persistence, rng, seasonOf, selection, teamGames, wilson, zOf,
  type Cell, type TeamGame,
} from "../subgroups.ts";

const arg = (n: string, f?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const dir = arg("history", "football/history")!;
const SPLIT = "2025-01-01"; // A と同じ境界
const MIN_N = 30;

const leagues = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).map((f) => f.replace(".ndjson", ""));
const rows = leagues.flatMap((lg) => readHistory(dir, lg));

// 市場全体の本命・大穴の偏り（γ）は前半だけから当てる
const fitRows = rows
  .filter((r) => r.date < SPLIT && r.odds && r.odds.home > 1 && r.odds.draw > 1 && r.odds.away > 1)
  .map((r) => {
    const inv = [1 / r.odds!.home, 1 / r.odds!.draw, 1 / r.odds!.away];
    const s = inv[0]! + inv[1]! + inv[2]!;
    return { p: [inv[0]! / s, inv[1]! / s, inv[2]! / s] as [number, number, number], outcome: (r.homeGoals > r.awayGoals ? 0 : r.homeGoals === r.awayGoals ? 1 : 2) as 0 | 1 | 2 };
  });
const gamma = fitGamma(fitRows);
const raw = teamGames(rows, 1);
const adj = teamGames(rows, gamma);

/**
 * 試合の文脈（その試合より前に分かっていたことだけ）: 季節の何試合目か・昇格組か・
 * 前の試合の得失点差・連勝/連敗の長さ。キーは「日付|リーグ|チーム」
 */
interface Ctx { idx: number; newcomer: boolean | null; lastMargin: number | null; streak: number }
const ctx = new Map<string, Ctx>();
{
  const byTeam = new Map<string, Array<{ date: string; league: string; margin: number }>>();
  for (const r of rows) {
    for (const [team, m] of [[r.home, r.homeGoals - r.awayGoals], [r.away, r.awayGoals - r.homeGoals]] as const) {
      const k = `${r.division}:${team}`;
      (byTeam.get(k) ?? byTeam.set(k, []).get(k)!).push({ date: r.date, league: r.division, margin: m });
    }
  }
  const teamsBySeason = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${r.division}|${seasonOf({ league: r.division, date: r.date })}`;
    const set = teamsBySeason.get(k) ?? teamsBySeason.set(k, new Set()).get(k)!;
    set.add(r.home);
    set.add(r.away);
  }
  const prevSeason = (lg: string, s: string): string => {
    if (lg === "JAP") return String(Number(s) - 1);
    const y = Number(s.slice(0, 4)) - 1;
    return `${y}-${(y + 1) % 100}`;
  };
  for (const [k, gs] of byTeam) {
    gs.sort((a, b) => a.date.localeCompare(b.date));
    const team = k.slice(k.indexOf(":") + 1);
    let season = "";
    let idx = 0;
    let streak = 0;
    let last: number | null = null;
    for (const g of gs) {
      const s = seasonOf(g);
      if (s !== season) {
        season = s;
        idx = 0;
        streak = 0;
        last = null;
      }
      idx++;
      const prev = teamsBySeason.get(`${g.league}|${prevSeason(g.league, s)}`);
      // 前の季節がデータの外（2021-22・2021）なら判定しない
      const newcomer = prev && prev.size > 10 ? !prev.has(team) : null;
      ctx.set(`${g.date}|${g.league}|${team}`, { idx, newcomer, lastMargin: last, streak });
      last = g.margin;
      streak = g.margin > 0 ? (streak > 0 ? streak + 1 : 1) : g.margin < 0 ? (streak < 0 ? streak - 1 : -1) : 0;
    }
  }
}
const cx = (g: TeamGame): Ctx => ctx.get(`${g.date}|${g.league}|${g.team}`)!;
const pct = (x: number, d = 1) => (x * 100).toFixed(d);
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

console.log(`# 市場の切り口別の偏り（前半 < ${SPLIT} ≤ 後半）`);
console.log(`試合 ${rows.length}・チーム×試合 ${adj.length}・前半で当てた γ = ${gamma.toFixed(3)}（以下、断りが無ければ γ 補正後の市場と比べる）\n`);

// ---- 1. 切り口ごとの 3 判定 ----
const band = (g: TeamGame) => `${Math.min(9, Math.floor(g.p * 10)) * 10}%台`;
const dims: Array<[string, (g: TeamGame) => string | null]> = [
  ["チーム", (g) => `${g.league}:${g.team}`],
  ["チーム×ホーム/アウェイ", (g) => `${g.league}:${g.team}:${g.role}`],
  ["チーム×本命/格下", (g) => `${g.league}:${g.team}:${g.p >= 0.45 ? "本命" : g.p <= 0.3 ? "格下" : "拮抗"}`],
  ["リーグ", (g) => g.league],
  ["リーグ×ホーム/アウェイ", (g) => `${g.league}:${g.role}`],
  ["勝率の帯", band],
  ["リーグ×勝率の帯", (g) => `${g.league}:${band(g)}`],
  ["月", (g) => g.date.slice(5, 7)],
  ["曜日", (g) => String(new Date(`${g.date}T12:00:00Z`).getUTCDay())],
  ["対戦カード（同じ 2 チーム）", (g) => `${g.league}:${g.team}>${g.opponent}`],
  ["季節の序盤（何試合目か）", (g) => { const i = cx(g).idx; return i <= 5 ? "1-5" : i <= 10 ? "6-10" : i <= 25 ? "11-25" : "26+"; }],
  ["昇格組（前季そのリーグにいない）", (g) => { const n = cx(g).newcomer; return n === null ? null : n ? "昇格組" : "残留組"; }],
  ["前の試合の結果（得失点差）", (g) => { const m = cx(g).lastMargin; return m === null ? null : m >= 3 ? "大勝" : m > 0 ? "勝ち" : m === 0 ? "分け" : m > -3 ? "負け" : "大敗"; }],
  ["連勝・連敗", (g) => { const s = cx(g).streak; return s >= 3 ? "3連勝以上" : s > 0 ? "1-2連勝" : s === 0 ? "なし" : s > -3 ? "1-2連敗" : "3連敗以上"; }],
  ["相手の前の試合（得失点差）", (g) => { const o = ctx.get(`${g.date}|${g.league}|${g.opponent}`)?.lastMargin ?? null; return o === null ? null : o >= 3 ? "大勝" : o > 0 ? "勝ち" : o === 0 ? "分け" : o > -3 ? "負け" : "大敗"; }],
];

console.log("## 1. 切り口ごとの判定（前半で探して後半で確かめる）");
console.log("| 切り口 | セル数 | 前半: 偶然を超えるばらつき（z） | 前半: 本当の差 τ | 後半: τ | 前後半の相関 r（p 値） | 前半 |z|≥2 で選んだセル: 数・前半の差 → 後半の差（z） |");
console.log("|---|---|---|---|---|---|---|");
const early = adj.filter((g) => g.date < SPLIT);
const late = adj.filter((g) => g.date >= SPLIT);
for (const [name, key] of dims) {
  const e = group(early, key);
  const l = group(late, key);
  const minN = name.startsWith("対戦カード") ? 6 : MIN_N;
  const he = heterogeneity(e, minN);
  const hl = heterogeneity(l, minN);
  const per = persistence(e, l, minN, 5000);
  const s = selection(e, l, 2, minN);
  console.log(
    `| ${name} | ${per.k} | ${f2(he.excessZ)} | ${f2(he.tauPp)}pp | ${f2(hl.tauPp)}pp | ${f2(per.r)}（${per.pPerm.toFixed(3)}） | ${s.picked}・${s.earlyDiffPp >= 0 ? "+" : ""}${f2(s.earlyDiffPp)}pp → ${s.lateDiffPp >= 0 ? "+" : ""}${f2(s.lateDiffPp)}pp（${f2(s.lateZ)}） |`,
  );
}

// ---- 1b. セルの少ない切り口は中身をそのまま出す（前半 / 後半の 実際 − 市場）----
console.log("\n## 1b. 少数のセルに分かれる切り口の中身（実際の勝率 − 市場, pp・括弧は z）");
for (const [name, key] of dims) {
  const e = group(early, key);
  const l = group(late, key);
  if (e.size > 12) continue;
  const cellTxt = (c: Cell | undefined) => (c && c.n ? `${c.sumR >= 0 ? "+" : ""}${pct(c.sumR / c.n)}（${f2(zOf(c))}・${c.n}）` : "—");
  console.log(`- **${name}**: ${[...e.keys()].sort().map((k) => `${k} ${cellTxt(e.get(k))} / ${cellTxt(l.get(k))}`).join("　")}`);
}

// ---- 2. チームを季節ごとに選び、翌季で確かめる（実運用と同じ手順）----
console.log("\n## 2. チーム: 季節ごとに選び、翌季で確かめる（γ 補正後）");
console.log("| 選んだ季節 → 確かめた季節 | チーム数 | 相関 r（p 値） | |z|≥2 の数 | 選んだチームの翌季の差（z） | |z|≥1.5 の数 | 翌季の差（z） |");
console.log("|---|---|---|---|---|---|---|");
const seasonsEu = ["2022-23", "2023-24", "2024-25", "2025-26"];
const seasonsJp = ["2022", "2023", "2024", "2025"];
let poolR = 0;
let poolV = 0;
let poolN = 0;
for (let i = 0; i + 1 < seasonsEu.length; i++) {
  const inS = (g: TeamGame, k: number) => seasonOf(g) === (g.league === "JAP" ? seasonsJp[k] : seasonsEu[k]);
  const e = group(adj.filter((g) => inS(g, i)), (g) => `${g.league}:${g.team}`);
  const l = group(adj.filter((g) => inS(g, i + 1)), (g) => `${g.league}:${g.team}`);
  const per = persistence(e, l, 15, 5000);
  const s2 = selection(e, l, 2, 15);
  const s15 = selection(e, l, 1.5, 15);
  poolR += s2.lateDiffPp * s2.lateN;
  poolN += s2.lateN;
  poolV += s2.lateZ ** 2;
  console.log(`| ${seasonsEu[i]} → ${seasonsEu[i + 1]} | ${per.k} | ${f2(per.r)}（${per.pPerm.toFixed(3)}） | ${s2.picked} | ${s2.lateDiffPp >= 0 ? "+" : ""}${f2(s2.lateDiffPp)}pp（${f2(s2.lateZ)}） | ${s15.picked} | ${s15.lateDiffPp >= 0 ? "+" : ""}${f2(s15.lateDiffPp)}pp（${f2(s15.lateZ)}） |`);
}

// ---- 2b. 同じ季節の中で: 季節の前半で選び、同じ季節の後半で確かめる（選手の入れ替わりが少ない）----
console.log("\n## 2b. チーム: 同じ季節の前半（1〜15 試合目）で選び、後半（16 試合目〜）で確かめる");
console.log("| 季節 | チーム数 | 相関 r（p 値） | |z|≥1.5 の数 | 選んだチームの後半の差（z） |");
console.log("|---|---|---|---|---|");
for (let i = 0; i < seasonsEu.length; i++) {
  const inS = (g: TeamGame) => seasonOf(g) === (g.league === "JAP" ? seasonsJp[i] : seasonsEu[i]);
  const e = group(adj.filter((g) => inS(g) && cx(g).idx <= 15), (g) => `${g.league}:${g.team}`);
  const l = group(adj.filter((g) => inS(g) && cx(g).idx > 15), (g) => `${g.league}:${g.team}`);
  const per = persistence(e, l, 10, 5000);
  const s15 = selection(e, l, 1.5, 10);
  console.log(`| ${seasonsEu[i]} | ${per.k} | ${f2(per.r)}（${per.pPerm.toFixed(3)}） | ${s15.picked} | ${s15.lateDiffPp >= 0 ? "+" : ""}${f2(s15.lateDiffPp)}pp（${f2(s15.lateZ)}） |`);
}

// ---- 3. 前半で目立ったチームの一覧（後半でどうなったか）----
console.log("\n## 3. 前半で市場から最も外れていたチーム（上位 12）と、後半の姿");
console.log("| チーム | 前半: 試合・実際の勝率 − 市場（z） | 後半: 試合・実際の勝率 − 市場（z） |");
console.log("|---|---|---|");
{
  const e = group(early, (g) => `${g.league}:${g.team}`);
  const l = group(late, (g) => `${g.league}:${g.team}`);
  const top = [...e.entries()].filter(([, c]) => c.n >= MIN_N).sort((a, b) => Math.abs(zOf(b[1])) - Math.abs(zOf(a[1]))).slice(0, 12);
  const show = (c: Cell | undefined) => (c && c.n ? `${c.n}・${pct(c.wins / c.n)}% − ${pct(c.sumP / c.n)}% = ${c.sumR >= 0 ? "+" : ""}${pct(c.sumR / c.n)}pp（${f2(zOf(c))}）` : "後半に試合なし");
  for (const [k, c] of top) console.log(`| ${k} | ${show(c)} | ${show(l.get(k))} |`);
}

// ---- 4. 賭けで確かめる: 前半で「過小評価」のチームを後半に買い続けたら ----
console.log("\n## 4. 前半 z ≥ 2 のチームの勝ちを、後半に取得元のオッズ（1 社・控除込み）で 1 単位ずつ買った場合");
{
  const e = group(early, (g) => `${g.league}:${g.team}`);
  for (const zMin of [2, 1.5]) {
    const picks = new Set([...e.entries()].filter(([, c]) => c.n >= MIN_N && zOf(c) >= zMin).map(([k]) => k));
    const bets = late.filter((g) => picks.has(`${g.league}:${g.team}`));
    const ret = bets.reduce((a, g) => a + (g.win ? g.odds : 0), 0);
    console.log(`- z ≥ ${zMin}${zMin === 2 ? "（事前の基準）" : "（補足・事前の基準ではない）"}: 選んだチーム ${picks.size}・後半 ${bets.length} 回・回収率 ${bets.length ? `${pct(ret / bets.length)}%` : "—"}`);
  }
  const all = late.reduce((a, g) => a + (g.win ? g.odds : 0), 0);
  console.log(`- 比較: 後半の全チームの勝ちを全部買った場合 ${late.length} 回・回収率 ${pct(all / late.length)}%（控除の分だけ 100% を下回るのが基準）`);
}

// ---- 4b. 引き分け: 試合単位で、市場の引き分け確率（補正前）と比べる ----
console.log("\n## 4b. 引き分け（試合単位・補正前の市場）: 切り口ごとに前半で探し後半で確かめる");
console.log("| 切り口 | セル数 | 前後半の相関 r（p 値） | 前半 |z|≥2 のセル: 数・前半 → 後半（z） |");
console.log("|---|---|---|---|");
{
  const dg = rows
    .filter((r) => r.odds && r.odds.home > 1 && r.odds.draw > 1 && r.odds.away > 1)
    .map((r) => {
      const inv = [1 / r.odds!.home, 1 / r.odds!.draw, 1 / r.odds!.away];
      const s = inv[0]! + inv[1]! + inv[2]!;
      const p = [inv[0]! / s, inv[1]! / s, inv[2]! / s];
      return { date: r.date, league: r.division, p: p[1]!, gap: Math.abs(p[0]! - p[2]!), win: (r.homeGoals === r.awayGoals ? 1 : 0) as 0 | 1 };
    });
  const cuts: Array<[string, (g: (typeof dg)[number]) => string]> = [
    ["月", (g) => g.date.slice(5, 7)],
    ["リーグ", (g) => g.league],
    ["拮抗度（ホームとアウェイの勝率差）", (g) => (g.gap < 0.1 ? "<10pp" : g.gap < 0.25 ? "10-25pp" : g.gap < 0.45 ? "25-45pp" : "45pp+")],
    ["リーグ×月", (g) => `${g.league}:${g.date.slice(5, 7)}`],
  ];
  for (const [name, key] of cuts) {
    const e = group(dg.filter((g) => g.date < SPLIT) as unknown as TeamGame[], key as unknown as (g: TeamGame) => string);
    const l = group(dg.filter((g) => g.date >= SPLIT) as unknown as TeamGame[], key as unknown as (g: TeamGame) => string);
    const minN = name === "リーグ×月" ? 40 : MIN_N;
    const per = persistence(e, l, minN, 5000);
    const sel = selection(e, l, 2, minN);
    console.log(`| ${name} | ${per.k} | ${f2(per.r)}（${per.pPerm.toFixed(3)}） | ${sel.picked}・${sel.earlyDiffPp >= 0 ? "+" : ""}${f2(sel.earlyDiffPp)}pp → ${sel.lateDiffPp >= 0 ? "+" : ""}${f2(sel.lateDiffPp)}pp（${f2(sel.lateZ)}） |`);
  }
  const jan = (pred: (g: (typeof dg)[number]) => boolean) => {
    const s = dg.filter(pred);
    const k = s.reduce((a, g) => a + g.win, 0);
    const m = s.reduce((a, g) => a + g.p, 0);
    const [lo, hi] = wilson(k, s.length);
    return `${s.length} 試合・市場 ${pct(m / s.length)}% → 実際 ${pct(k / s.length)}%（${pct(lo)}–${pct(hi)}）`;
  };
  console.log(`- 1 月の引き分け（前半）: ${jan((g) => g.date < SPLIT && g.date.slice(5, 7) === "01")}`);
  console.log(`- 1 月の引き分け（後半）: ${jan((g) => g.date >= SPLIT && g.date.slice(5, 7) === "01")}`);
  console.log(`- 1 月以外の引き分け（全期間）: ${jan((g) => g.date.slice(5, 7) !== "01")}`);
}

// ---- 5. 「56%」は本当に 56% か: 市場の勝率の帯ごとの実際の勝率 ----
console.log("\n## 5. 市場が「勝率 X%」と言った時、実際に何 % 勝ったか（チーム×試合・補正前の市場）");
console.log("| 市場の勝率 | 前半: 件数・実際（95% 区間） | 後半: 件数・実際（95% 区間） |");
console.log("|---|---|---|");
for (let lo = 0.05; lo < 0.9; lo += 0.05) {
  const hi = lo + 0.05;
  const cell = (gs: TeamGame[]) => {
    const s = gs.filter((g) => g.market[g.role === "H" ? 0 : 2] >= lo && g.market[g.role === "H" ? 0 : 2] < hi);
    if (!s.length) return "—";
    const k = s.reduce((a, g) => a + g.win, 0);
    const m = s.reduce((a, g) => a + g.market[g.role === "H" ? 0 : 2], 0) / s.length;
    const [a, b] = wilson(k, s.length);
    return `${s.length}・市場平均 ${pct(m)}% → 実際 ${pct(k / s.length)}%（${pct(a)}–${pct(b)}）`;
  };
  console.log(`| ${Math.round(lo * 100)}–${Math.round(hi * 100)}% | ${cell(raw.filter((g) => g.date < SPLIT))} | ${cell(raw.filter((g) => g.date >= SPLIT))} |`);
}

// ---- 6. 検出力: 本当にチーム差があったら、このデータで見えたか ----
console.log("\n## 6. 検出力: チームごとに本当の差（τ）があったら、前後半の相関で検出できた確率（実データの試合数で 200 回模擬）");
{
  const e = group(early, (g) => `${g.league}:${g.team}`);
  const l = group(late, (g) => `${g.league}:${g.team}`);
  const keys = [...e.keys()].filter((k) => e.get(k)!.n >= MIN_N && (l.get(k)?.n ?? 0) >= MIN_N);
  const byKey = (gs: TeamGame[]) => {
    const m = new Map<string, number[]>();
    for (const g of gs) {
      const k = `${g.league}:${g.team}`;
      if (!keys.includes(k)) continue;
      (m.get(k) ?? m.set(k, []).get(k)!).push(g.p);
    }
    return m;
  };
  const pe = byKey(early);
  const pl = byKey(late);
  const rand = rng(7);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  for (const tau of [0.01, 0.02, 0.03, 0.04, 0.05]) {
    let hit = 0;
    const sims = 200;
    for (let s = 0; s < sims; s++) {
      const bias = new Map(keys.map((k) => [k, tau * gauss()]));
      const sim = (src: Map<string, number[]>) => {
        const m = new Map<string, Cell>();
        for (const [k, ps] of src) {
          const c: Cell = { n: 0, sumR: 0, v: 0, wins: 0, sumP: 0 };
          for (const p of ps) {
            const t = Math.min(0.99, Math.max(0.01, p + bias.get(k)!));
            const w = rand() < t ? 1 : 0;
            c.n++;
            c.sumR += w - p;
            c.v += p * (1 - p);
            c.wins += w;
            c.sumP += p;
          }
          m.set(k, c);
        }
        return m;
      };
      if (persistence(sim(pe), sim(pl), MIN_N, 200, s + 1).pPerm < 0.05) hit++;
    }
    console.log(`- τ = ${pct(tau, 0)}pp → 検出 ${pct(hit / sims, 0)}%`);
  }
}

// ---- 7. 1 月の引き分けを、最も鋭い市場（Pinnacle の締切直前）でも確かめる（--csv のときだけ）----
const csvDir = arg("csv");
if (csvDir) {
  console.log("\n## 7. 1 月の引き分け: Pinnacle（試合前・締切直前）と比べる（取得元 CSV・欧州 9 リーグ）");
  console.log("| 期間 | 試合 | 実際 | Pinnacle 試合前（z） | Pinnacle 締切（z） | 1 試合の平均得点 |");
  console.log("|---|---|---|---|---|---|");
  type C = { y: string; m: string; draw: 0 | 1; ps: number; psc: number | null; goals: number };
  const cs: C[] = [];
  for (const f of readdirSync(csvDir).filter((f) => /^fd-[A-Z0-9]+-\d{4}\.csv$/.test(f))) {
    const lines = readFileSync(`${csvDir}/${f}`, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
    const head = lines[0]!.split(",");
    const ix = (k: string) => head.indexOf(k);
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const n = (k: string) => (ix(k) >= 0 ? parseFloat(c[ix(k)] ?? "") : NaN);
      const hg = n("FTHG");
      const ag = n("FTAG");
      const ps = [n("PSH"), n("PSD"), n("PSA")];
      const psc = [n("PSCH"), n("PSCD"), n("PSCA")];
      if (!(hg >= 0 && ag >= 0) || !ps.every((x) => x > 1)) continue;
      const dvD = (o: number[]) => (1 / o[1]!) / (1 / o[0]! + 1 / o[1]! + 1 / o[2]!);
      const d = (c[ix("Date")] ?? "").split("/");
      cs.push({ y: d[2]!.length === 2 ? `20${d[2]}` : d[2]!, m: d[1]!, draw: hg === ag ? 1 : 0, ps: dvD(ps), psc: psc.every((x) => x > 1) ? dvD(psc) : null, goals: hg + ag });
    }
  }
  const row = (lab: string, s: C[]) => {
    const k = s.reduce((a, x) => a + x.draw, 0);
    const p = s.reduce((a, x) => a + x.ps, 0);
    const sc = s.filter((x) => x.psc !== null);
    const kc = sc.reduce((a, x) => a + x.draw, 0);
    const pc = sc.reduce((a, x) => a + x.psc!, 0);
    const z = (k: number, p: number, n: number) => f2((k - p) / Math.sqrt(p * (1 - p / n)));
    console.log(`| ${lab} | ${s.length} | ${pct(k / s.length)}% | ${pct(p / s.length)}%（${z(k, p, s.length)}） | ${sc.length ? `${pct(pc / sc.length)}%（${z(kc, pc, sc.length)}）` : "—"} | ${(s.reduce((a, x) => a + x.goals, 0) / s.length).toFixed(2)} |`);
  };
  for (const y of [...new Set(cs.filter((x) => x.m === "01").map((x) => x.y))].sort()) row(`${y} 年 1 月`, cs.filter((x) => x.m === "01" && x.y === y));
  row("1 月 合計", cs.filter((x) => x.m === "01"));
  row("1 月以外", cs.filter((x) => x.m !== "01"));
}
