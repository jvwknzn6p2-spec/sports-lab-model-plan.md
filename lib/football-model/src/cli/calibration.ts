/**
 * 「モデルの 56% は本当に 56% か」を測る（2026-10-09）。正準 dc-v5-shots を過去の情報だけで
 * 当て直し（14 日ごと）、予想の帯ごとに実際の頻度を数える。市場（同じ試合）と並べる。
 * 台帳には触れない（履歴を読むだけ）。
 *
 *   node --experimental-strip-types src/cli/calibration.ts --history ../../football/history
 */
import { group, persistence, heterogeneity, wilson, zOf, type TeamGame } from "../subgroups.ts";
import { readdirSync } from "node:fs";
import { readHistory, toMatchWithOdds } from "../history.ts";
import { fitDixonColes, fitShotLayer, predictWithShots } from "../fit.ts";
const arg = (n: string, f?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const dir = arg("history", "football/history")!;
// 正準と同じ設定（cli/football.ts の定数）。当て直しは 14 日ごと（毎日ではない＝少し古い学習で予想する近似）
const FROM = arg("from", "2023-01-01")!, UNTIL = arg("until", "2026-09-21")!, STEP = 14, WINDOW = 1500, XI = 0.002, RIDGE = 2, SW = 0.25, MIN_TRAIN = 300, MIN_TEAM = 5;
const out: any[] = [];
for (const lg of readdirSync(dir).map((f) => f.replace(".ndjson", ""))) {
  const rows = readHistory(dir, lg);
  const hist = rows.map(toMatchWithOdds);
  for (let t = Date.parse(FROM + "T00:00:00Z"); t < Date.parse(UNTIL + "T00:00:00Z"); t += STEP * 864e5) {
    const asOf = new Date(t).toISOString();
    const train = hist.filter((m) => Date.parse(m.date) < t && Date.parse(m.date) >= t - WINDOW * 864e5);
    const idx = rows.map((r, i) => i).filter((i) => { const d = Date.parse(hist[i].date); return d >= t && d < t + STEP * 864e5; });
    if (!idx.length || train.length < MIN_TRAIN) continue;
    const fit = fitDixonColes(train, { asOf, ridge: RIDGE, xi: XI });
    const layer = fitShotLayer(train, SW, { asOf, ridge: RIDGE, xi: XI }, MIN_TRAIN);
    const cnt = new Map<string, number>();
    for (const m of train) { cnt.set(m.home, (cnt.get(m.home) ?? 0) + 1); cnt.set(m.away, (cnt.get(m.away) ?? 0) + 1); }
    for (const i of idx) {
      const r = rows[i];
      if (Math.min(cnt.get(r.home) ?? 0, cnt.get(r.away) ?? 0) < MIN_TEAM) continue;
      let p;
      try { p = predictWithShots(fit, layer, r.home, r.away); } catch { continue; }
      out.push({ league: lg, date: r.date, home: r.home, away: r.away, hg: r.homeGoals, ag: r.awayGoals, odds: r.odds, p: [p.outcome.home, p.outcome.draw, 1 - p.outcome.home - p.outcome.draw] });
    }
  }
}
const rows = out.filter((r) => r.odds && r.odds.home > 1 && r.odds.draw > 1 && r.odds.away > 1);
const dv = (o: any) => { const i = [1 / o.home, 1 / o.draw, 1 / o.away]; const s = i[0] + i[1] + i[2]; return i.map((x) => x / s); };
const res = (r: any) => (r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2);
const rps = (p: number[], o: number) => { const c1 = p[0] - (o === 0 ? 1 : 0), c2 = p[0] + p[1] - (o <= 1 ? 1 : 0); return (c1 * c1 + c2 * c2) / 2; };
const pct = (x: number) => (x * 100).toFixed(1);
let rm = 0, rk = 0; const d: number[] = [];
for (const r of rows) { const a = rps(r.p, res(r)), b = rps(dv(r.odds), res(r)); rm += a; rk += b; d.push(a - b); }
const n = rows.length, md = d.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(d.reduce((a, b) => a + (b - md) ** 2, 0) / (n - 1));
console.log(`試合 ${n}（${rows[0].date}〜）RPS モデル ${(rm / n).toFixed(4)} / 市場 ${(rk / n).toFixed(4)} 差 ${md.toFixed(4)}（t=${(md / (sd / Math.sqrt(n))).toFixed(2)}）`);
// 勝率の較正（ホーム・アウェイの勝ちを 1 本に）
type U = { pm: number; pk: number; y: number };
const us: U[] = [];
for (const r of rows) { const k = dv(r.odds), o = res(r); us.push({ pm: r.p[0], pk: k[0], y: o === 0 ? 1 : 0 }, { pm: r.p[2], pk: k[2], y: o === 2 ? 1 : 0 }); }
const ds: U[] = rows.map((r) => ({ pm: r.p[1], pk: dv(r.odds)[1], y: res(r) === 1 ? 1 : 0 }));
function table(label: string, xs: U[], f: "pm" | "pk", step = 0.05) {
  console.log(`\n### ${label}`); console.log("| 予想の帯 | 件数 | 予想の平均 | 実際（95% 区間） | 差 |"); console.log("|---|---|---|---|---|");
  let ece = 0;
  for (let lo = 0; lo < 1; lo += step) {
    const s = xs.filter((u) => u[f] >= lo && u[f] < lo + step); if (s.length < 20) continue;
    const k = s.reduce((a, u) => a + u.y, 0), m = s.reduce((a, u) => a + u[f], 0) / s.length, [a, b] = wilson(k, s.length);
    ece += (s.length / xs.length) * Math.abs(k / s.length - m);
    console.log(`| ${Math.round(lo * 100)}–${Math.round((lo + step) * 100)}% | ${s.length} | ${pct(m)}% | ${pct(k / s.length)}%（${pct(a)}–${pct(b)}） | ${k / s.length - m >= 0 ? "+" : ""}${pct(k / s.length - m)} |`);
  }
  console.log(`較正誤差（ECE・件数加重の |実際 − 予想|）: ${pct(ece)}pp`);
}
table("正準モデルの勝率（ホーム・アウェイ）", us, "pm");
table("市場の勝率（同じ試合）", us, "pk");
table("正準モデルの引き分け率", ds, "pm", 0.03);
table("市場の引き分け率（同じ試合）", ds, "pk", 0.03);
// モデルの「56%」
const s56 = us.filter((u) => u.pm >= 0.54 && u.pm < 0.58), k56 = s56.reduce((a, u) => a + u.y, 0), w = wilson(k56, s56.length);
console.log(`\nモデルが 54–58%（平均 ${pct(s56.reduce((a, u) => a + u.pm, 0) / s56.length)}%）と言った ${s56.length} 件: 実際 ${pct(k56 / s56.length)}%（${pct(w[0])}–${pct(w[1])}）`);
// モデルのチーム別の外れ（前半 < 2025 / 後半）
const tg: TeamGame[] = [];
for (const r of rows) { const o = res(r); tg.push({ date: r.date, league: r.league, team: r.home, opponent: r.away, role: "H", p: r.p[0], market: r.p, win: o === 0 ? 1 : 0, odds: 0 }, { date: r.date, league: r.league, team: r.away, opponent: r.home, role: "A", p: r.p[2], market: r.p, win: o === 2 ? 1 : 0, odds: 0 }); }
const key = (g: TeamGame) => `${g.league}:${g.team}`;
const e = group(tg.filter((g) => g.date < "2025-01-01"), key), l = group(tg.filter((g) => g.date >= "2025-01-01"), key);
const per = persistence(e, l, 30, 5000), he = heterogeneity(e, 30), hl = heterogeneity(l, 30);
console.log(`\nモデルのチーム別の外れ: 前半 τ ${he.tauPp.toFixed(2)}pp（超過 z ${he.excessZ.toFixed(2)}）/ 後半 τ ${hl.tauPp.toFixed(2)}pp（超過 z ${hl.excessZ.toFixed(2)}）/ 前後半の相関 r ${per.r.toFixed(2)}（p ${per.pPerm.toFixed(3)}・${per.k} チーム）`);
// 1 月の引き分け
for (const [lab, f] of [["1月", (r: any) => r.date.slice(5, 7) === "01"], ["1月以外", (r: any) => r.date.slice(5, 7) !== "01"]] as const) {
  const s = rows.filter(f), k = s.filter((r) => res(r) === 1).length;
  console.log(`${lab}の引き分け: ${s.length} 試合・実際 ${pct(k / s.length)}% / モデル ${pct(s.reduce((a, r) => a + r.p[1], 0) / s.length)}% / 市場 ${pct(s.reduce((a, r) => a + dv(r.odds)[1], 0) / s.length)}%`);
}
