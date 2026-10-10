/**
 * Steam ムーブ（試合前 → 締切直前のオッズの動き）の分析（2026-10-10・Founder 指示）。
 * 規則は固定の基準と同じ: **年ごとに独立**（2024 / 2025 / 2026）。前半・後半に分けない。
 *
 *   node --experimental-strip-types src/cli/steam.ts --csv ../../probe/football
 *
 * データは取得元 CSV（football-data.co.uk）の 2 時点だけ: 試合前（Avg・Max・PS = Pinnacle）と
 * 締切直前（AvgC・MaxC・PSC）。途中の時系列は無いので「いつ動いたか」は分からない。
 *
 * **結果を見る前に固定した定義**
 *  - 動き = 締切の確率 − 試合前の確率（各社平均を控除を除いて割り戻した値・結果ごと）
 *  - Steam = ある結果の確率が +3pp 以上上がった（強い Steam = +5pp 以上）
 *  - 問い:
 *    1. どれくらい起きるか
 *    2. 締切の確率は動きを織り込み切っているか（実際 − 締切。正なら「まだ足りない」＝追い風が続く）
 *    3. 動いた側を締切の価格で買うと得か（各社平均・最高値）。試合前の価格で買えた場合は参考（実際には
 *       動く前に知る手段が要る）
 *    4. Pinnacle が先に動き、他社の締切価格がまだ追いついていない（最高値 × Pinnacle 締切の確率 > 1）
 *       ときに他社で買うと得か（2024・2025 年のみ。2026 年は Pinnacle の列がほぼ無い）
 */
import { readdirSync, readFileSync } from "node:fs";

type T = [number, number, number];
interface Row {
  y: string;
  lg: string;
  o: 0 | 1 | 2;
  avg: T;
  avgc: T;
  mx: T;
  mxc: T;
  ps: T | null;
  psc: T | null;
}

const arg = (n: string, f?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const dir = arg("csv", "probe/football")!;
const YEARS = ["2024", "2025", "2026"];
const STEAM = 0.03;
const STRONG = 0.05;

const rows: Row[] = [];
for (const f of readdirSync(dir).filter((f) => /^fd-[A-Z0-9]+-\d{4}\.csv$/.test(f))) {
  const lines = readFileSync(`${dir}/${f}`, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const h = lines[0]!.split(",");
  const ix = (k: string) => h.indexOf(k);
  for (const l of lines.slice(1)) {
    const c = l.split(",");
    const n = (k: string) => (ix(k) >= 0 ? parseFloat(c[ix(k)] ?? "") : NaN);
    const t = (p: string): T | null => {
      const v: T = [n(`${p}H`), n(`${p}D`), n(`${p}A`)];
      return v.every((x) => x > 1) ? v : null;
    };
    const hg = n("FTHG");
    const ag = n("FTAG");
    const d = (c[ix("Date")] ?? "").split("/");
    if (!(hg >= 0 && ag >= 0) || d.length < 3) continue;
    const y = d[2]!.length === 2 ? `20${d[2]}` : d[2]!;
    const avg = t("Avg");
    const avgc = t("AvgC");
    const mx = t("Max");
    const mxc = t("MaxC");
    if (!YEARS.includes(y) || !avg || !avgc || !mx || !mxc) continue;
    rows.push({ y, lg: f.split("-")[1]!, o: hg > ag ? 0 : hg === ag ? 1 : 2, avg, avgc, mx, mxc, ps: t("PS"), psc: t("PSC") });
  }
}

const dv = (o: T): T => {
  const i = o.map((x) => 1 / x);
  const s = i[0]! + i[1]! + i[2]!;
  return [i[0]! / s, i[1]! / s, i[2]! / s];
};
const rps = (p: T, o: number) => ((p[0] - (o === 0 ? 1 : 0)) ** 2 + (p[0] + p[1] - (o <= 1 ? 1 : 0)) ** 2) / 2;
const stat = (xs: number[]) => {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, m, t: n > 1 ? m / (sd / Math.sqrt(n)) : 0 };
};
const pc = (x: number, d = 1) => (x * 100).toFixed(d);
const roi = (xs: number[]) => {
  const s = stat(xs);
  return s.n ? `${s.n} 回・回収率 ${pc(1 + s.m)}%（t ${s.t.toFixed(2)}）` : "0 回";
};

console.log("# Steam ムーブの分析（年ごとに独立・取得元 CSV の試合前 → 締切直前）\n");
for (const y of YEARS) {
  const ys = rows.filter((r) => r.y === y);
  console.log(`## ${y} 年（${ys.length} 試合）`);

  // 1. 頻度
  const moves = ys.flatMap((r) => {
    const a = dv(r.avg);
    const b = dv(r.avgc);
    return [0, 1, 2].map((k) => ({ r, k, mv: b[k]! - a[k]!, pOpen: a[k]!, pClose: b[k]!, hit: r.o === k ? 1 : 0 }));
  });
  const steamMatches = ys.filter((r) => {
    const a = dv(r.avg);
    const b = dv(r.avgc);
    return [0, 1, 2].some((k) => b[k]! - a[k]! >= STEAM);
  }).length;
  const strongMatches = ys.filter((r) => {
    const a = dv(r.avg);
    const b = dv(r.avgc);
    return [0, 1, 2].some((k) => b[k]! - a[k]! >= STRONG);
  }).length;
  const absMv = moves.map((m) => Math.abs(m.mv)).sort((p, q) => p - q);
  console.log(`- 頻度: どれかの結果が +3pp 以上動いた試合 ${steamMatches}（${pc(steamMatches / ys.length)}%）・+5pp 以上 ${strongMatches}（${pc(strongMatches / ys.length)}%）・動きの絶対値の中央値 ${pc(absMv[absMv.length >> 1]!, 2)}pp・上位 5% ${pc(absMv[Math.floor(absMv.length * 0.95)]!, 2)}pp`);

  // 情報量: 締切は試合前よりどれだけ当たるか
  const inf = stat(ys.map((r) => rps(dv(r.avgc), r.o) - rps(dv(r.avg), r.o)));
  console.log(`- 情報の到着: RPS 締切 − 試合前 = ${inf.m.toFixed(4)}（t ${inf.t.toFixed(2)}）`);

  // 2. 織り込み切っているか（動いた側・逆に動いた側）
  for (const [lab, f] of [
    ["+3pp 以上上がった側（Steam）", (m: (typeof moves)[number]) => m.mv >= STEAM],
    ["+5pp 以上上がった側（強い Steam）", (m: (typeof moves)[number]) => m.mv >= STRONG],
    ["3pp 以上下がった側", (m: (typeof moves)[number]) => m.mv <= -STEAM],
  ] as const) {
    const s = moves.filter(f);
    if (!s.length) continue;
    const act = s.reduce((a, m) => a + m.hit, 0) / s.length;
    const po = s.reduce((a, m) => a + m.pOpen, 0) / s.length;
    const pcl = s.reduce((a, m) => a + m.pClose, 0) / s.length;
    const z = (s.reduce((a, m) => a + m.hit - m.pClose, 0)) / Math.sqrt(s.reduce((a, m) => a + m.pClose * (1 - m.pClose), 0));
    console.log(`- ${lab}: ${s.length} 件・試合前 ${pc(po)}% → 締切 ${pc(pcl)}% → 実際 ${pc(act)}%（実際 − 締切の z ${z.toFixed(2)}）`);
  }

  // 3. 動いた側を買う
  const up = moves.filter((m) => m.mv >= STEAM);
  const ret = (price: (r: Row) => T) => up.map((m) => (m.hit ? price(m.r)[m.k]! - 1 : -1));
  console.log(`- +3pp 以上上がった側を買う: 締切の各社平均 ${roi(ret((r) => r.avgc))}／締切の最高値 ${roi(ret((r) => r.mxc))}／参考: 試合前の最高値（動く前に買えた場合） ${roi(ret((r) => r.mx))}`);
  const down = moves.filter((m) => m.mv <= -STEAM);
  console.log(`- 3pp 以上下がった側を締切の最高値で買う（逆張り）: ${roi(down.map((m) => (m.hit ? m.r.mxc[m.k]! - 1 : -1)))}`);

  // 4. Pinnacle 先行・他社の締切価格が追いついていない
  const pin = ys.filter((r) => r.ps && r.psc);
  if (pin.length > 200) {
    const r4: number[] = [];
    for (const r of pin) {
      const a = dv(r.ps!);
      const b = dv(r.psc!);
      for (let k = 0; k < 3; k++) if (b[k]! - a[k]! >= STEAM && r.mxc[k]! * b[k]! > 1) r4.push(r.o === k ? r.mxc[k]! - 1 : -1);
    }
    console.log(`- Pinnacle が +3pp 動き、締切の最高値がまだ Pinnacle の締切確率より得な側を買う: ${roi(r4)}`);
  } else {
    console.log(`- Pinnacle の列がある試合が ${pin.length} 件のため、Pinnacle 先行の検定はこの年は行わない`);
  }
  // 5. 動きを試合前の時点で予測できるか（試合前に分かる量だけ）
  //   a) 試合前の各社のばらつき: 最高値 ÷ 平均 − 1（1 社だけ高い価格を出している結果）
  //   b) 試合前の確率の帯（本命か大穴か）
  const corr = (xs: number[], ys2: number[]) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys2.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i]! - mx) * (ys2[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
      syy += (ys2[i]! - my) ** 2;
    }
    const r = sxy / Math.sqrt(sxx * syy);
    return `${r.toFixed(3)}（t ${((r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r)).toFixed(2)}）`;
  };
  const disp = moves.map((m) => m.r.mx[m.k]! / m.r.avg[m.k]! - 1);
  console.log(`- 予測 a) 試合前のばらつき（最高値 ÷ 平均 − 1）と動きの相関: ${corr(disp, moves.map((m) => m.mv))}`);
  const bands = [[0, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 1]] as const;
  console.log(`- 予測 b) 試合前の確率の帯ごとの平均の動き: ${bands.map(([lo, hi]) => { const s = moves.filter((m) => m.pOpen >= lo && m.pOpen < hi); return `${pc(lo, 0)}-${pc(hi, 0)}% ${s.length ? (s.reduce((a, m) => a + m.mv, 0) / s.length * 100).toFixed(2) : "—"}pp`; }).join("・")}`);
  console.log("");
}
