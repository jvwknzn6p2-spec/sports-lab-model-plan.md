/**
 * モデルの能力を測る**固定の基準**（2026-10-09・Founder 指示）。
 *
 * **測り方の規則（Founder 指示・今後の全ての仮説と能力測定に適用）**
 *  1. 採点するのは 2024 年・2025 年・2026 年（〜2026-09-20）の試合だけ。データは
 *     `football/benchmark/v1/matches.ndjson` に凍結し、sha256 が一致しなければ測らない
 *  2. **年ごとに独立に採点する**。2024 年の数字は 2024 年の試合だけ、2025 年は 2025 年の試合だけ。
 *     年をまたいで合算した数字・ある年で決めたもの（係数・選んだチーム・閾値）を別の年で
 *     確かめる数字は**採用しない**（現実には 2024 年の能力で 2025 年を予想することは無いため）
 *  3. 1 つの年を前半・後半に分けて「前半で決めて後半で測る」こともしない
 *  4. 各試合の予想は、その試合の 2 日前（現地の日付）までに終わった試合だけで学習する
 *     （本番と同じく毎回学び直す。2024 年 1 月の予想は 2023 年以前の試合を記憶として使う。
 *     記憶に使うだけで採点はしない）
 *
 * このモジュールは 2. を API で強制する: 採点の関数は 1 つの年しか受け取らない。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fitDixonColes, fitShotLayer, predictWithShots, type MatchRecord } from "./fit.ts";

export const BENCHMARK = {
  version: "v1",
  file: "matches.ndjson",
  sha256: "5523111fcd46c48be2dbde58e9864fd99bf4a74a963dfae17a5fb83fa7c05db8",
  rows: 14285,
  /** 採点する年（それぞれ独立） */
  years: ["2024", "2025", "2026"] as const,
  /** 凍結したデータの最終日（2026 年はここまで） */
  until: "2026-09-20",
} as const;

export type BenchmarkYear = (typeof BENCHMARK.years)[number];

export interface BenchRow {
  division: string;
  date: string;
  time: string | null;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  odds: { home: number; draw: number; away: number } | null;
  sot?: { home: number; away: number };
}

/** 凍結データを読む。中身が 1 バイトでも違えば例外（基準が黙って変わるのを防ぐ） */
export function loadBenchmark(dir: string): BenchRow[] {
  const text = readFileSync(`${dir}/${BENCHMARK.file}`, "utf8");
  const sha = createHash("sha256").update(text).digest("hex");
  if (sha !== BENCHMARK.sha256) throw new Error(`基準データが凍結時と違う: sha256 ${sha}（期待 ${BENCHMARK.sha256}）`);
  const rows = text.trim().split("\n").map((l) => JSON.parse(l) as BenchRow);
  if (rows.length !== BENCHMARK.rows) throw new Error(`基準データの件数が違う: ${rows.length}`);
  return rows;
}

export const yearOf = (date: string): string => date.slice(0, 4);

export interface ModelConfig {
  name: string;
  xi: number;
  ridge: number;
  windowDays: number;
  shotWeight: number;
  minTrain: number;
}

/** 現行の正準（cli/football.ts の定数と同じ。canonical-model.test.ts が CLI 側を固定している） */
export const CANONICAL: ModelConfig = { name: "dc-v5-shots", xi: 0.002, ridge: 2, windowDays: 1500, shotWeight: 0.25, minTrain: 300 };

export interface BenchPrediction {
  league: string;
  date: string;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  odds: BenchRow["odds"];
  /** モデル（H, D, A） */
  p: [number, number, number];
  /** 学習に使った試合の最終日（リーク検査用） */
  trainedUntil: string;
}

const DAY = 86_400_000;
const toRecord = (r: BenchRow): MatchRecord => ({
  date: `${r.date}T${r.time ?? "00:00"}:00Z`,
  home: r.home,
  away: r.away,
  homeGoals: r.homeGoals,
  awayGoals: r.awayGoals,
  ...(r.sot ? { homeSot: r.sot.home, awaySot: r.sot.away } : {}),
});

/**
 * 1 つの年の試合を、試合日ごとに学び直して予想する（ウォークフォワード）。
 * 学習は「試合日の 2 日前まで（現地の日付）」の試合だけ。予想できない試合（学習に出ていない
 * チーム・学習データ不足）は出さない（本番と同じ）。
 */
/** `year` は採点する年か、記憶の年（2023・市場基盤モデルの係数の学習にだけ使う。採点しない） */
export function predictYear(rows: readonly BenchRow[], year: BenchmarkYear | "2023", cfg: ModelConfig = CANONICAL): BenchPrediction[] {
  const out: BenchPrediction[] = [];
  const leagues = [...new Set(rows.map((r) => r.division))].sort();
  for (const lg of leagues) {
    const all = rows.filter((r) => r.division === lg).sort((a, b) => a.date.localeCompare(b.date));
    const days = [...new Set(all.filter((r) => yearOf(r.date) === year).map((r) => r.date))].sort();
    for (const d of days) {
      const t = Date.parse(`${d}T00:00:00Z`);
      const lastDay = new Date(t - 2 * DAY).toISOString().slice(0, 10);
      const first = new Date(t - cfg.windowDays * DAY).toISOString().slice(0, 10);
      const train = all.filter((r) => r.date <= lastDay && r.date >= first).map(toRecord);
      if (train.length < cfg.minTrain) continue;
      const asOf = `${new Date(t - DAY).toISOString().slice(0, 10)}T11:00:00Z`; // 前日 20:00 JST（封緘）
      const fit = fitDixonColes(train, { asOf, ridge: cfg.ridge, xi: cfg.xi });
      const layer = fitShotLayer(train, cfg.shotWeight, { asOf, ridge: cfg.ridge, xi: cfg.xi }, cfg.minTrain);
      const trainedUntil = train.reduce((a, r) => (r.date.slice(0, 10) > a ? r.date.slice(0, 10) : a), "");
      for (const r of all.filter((x) => x.date === d)) {
        let p;
        try {
          p = predictWithShots(fit, layer, r.home, r.away);
        } catch {
          continue; // 学習に 1 度も出ていないチーム
        }
        const ph = p.outcome.home;
        const pd = p.outcome.draw;
        out.push({ league: lg, date: r.date, home: r.home, away: r.away, homeGoals: r.homeGoals, awayGoals: r.awayGoals, odds: r.odds, p: [ph, pd, 1 - ph - pd], trainedUntil });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 採点（1 つの年だけ）
// ---------------------------------------------------------------------------

export type Triple = [number, number, number];
export const outcomeOf = (r: { homeGoals: number; awayGoals: number }): 0 | 1 | 2 => (r.homeGoals > r.awayGoals ? 0 : r.homeGoals === r.awayGoals ? 1 : 2);
export function devig(o: { home: number; draw: number; away: number }): Triple {
  const i = [1 / o.home, 1 / o.draw, 1 / o.away];
  const s = i[0]! + i[1]! + i[2]!;
  return [i[0]! / s, i[1]! / s, i[2]! / s];
}
export const rpsOf = (p: Triple, o: 0 | 1 | 2): number => {
  const c1 = p[0] - (o === 0 ? 1 : 0);
  const c2 = p[0] + p[1] - (o <= 1 ? 1 : 0);
  return (c1 * c1 + c2 * c2) / 2;
};
const brierOf = (p: Triple, o: number): number => p.reduce((a, x, k) => a + (x - (k === o ? 1 : 0)) ** 2, 0);
const loglossOf = (p: Triple, o: number): number => -Math.log(Math.max(1e-12, p[o]!));

export interface YearScore {
  year: string;
  n: number;
  rps: number;
  brier: number;
  logloss: number;
  /** 最も高い確率の結果が当たった割合 */
  hit: number;
  /** 較正誤差（勝ち・引き分け・負けの 3 つを 5pp の帯で・件数加重） */
  ece: number;
}

export interface YearComparison {
  year: string;
  /** モデルと比べる相手（市場など）と同じ試合だけ */
  n: number;
  a: YearScore;
  b: YearScore;
  /** RPS の差（a − b・負なら a が良い）と対応のある t */
  diff: number;
  t: number;
}

export function scoreYear(year: string, items: ReadonlyArray<{ date: string; p: Triple; o: 0 | 1 | 2 }>): YearScore {
  // 別の年の試合が混ざっていたら測らない（呼び出し側の取り違えを黙って絞り込まない）
  if (items.some((x) => yearOf(x.date) !== year)) throw new Error(`年をまたいで採点しない（${year} 以外の試合が混ざっている）`);
  const xs = items;
  const n = xs.length;
  const avg = (f: (x: (typeof xs)[number]) => number) => xs.reduce((a, x) => a + f(x), 0) / n;
  // 較正（3 結果 × 5pp 帯）
  const bins = new Map<number, { s: number; y: number; c: number }>();
  for (const x of xs)
    for (let k = 0; k < 3; k++) {
      const b = Math.min(19, Math.floor(x.p[k]! * 20));
      const e = bins.get(b) ?? bins.set(b, { s: 0, y: 0, c: 0 }).get(b)!;
      e.s += x.p[k]!;
      e.y += x.o === k ? 1 : 0;
      e.c++;
    }
  let ece = 0;
  for (const e of bins.values()) ece += (e.c / (3 * n)) * Math.abs(e.y / e.c - e.s / e.c);
  return {
    year,
    n,
    rps: avg((x) => rpsOf(x.p, x.o)),
    brier: avg((x) => brierOf(x.p, x.o)),
    logloss: avg((x) => loglossOf(x.p, x.o)),
    hit: avg((x) => (x.p.indexOf(Math.max(...x.p)) === x.o ? 1 : 0)),
    ece,
  };
}

/** 同じ年・同じ試合で 2 つの予想を比べる */
export function compareYear(year: string, items: ReadonlyArray<{ date: string; a: Triple; b: Triple; o: 0 | 1 | 2 }>): YearComparison {
  if (items.some((x) => yearOf(x.date) !== year)) throw new Error(`年をまたいで比べない（${year} 以外の試合が混ざっている）`);
  const xs = items;
  const d = xs.map((x) => rpsOf(x.a, x.o) - rpsOf(x.b, x.o));
  const n = d.length;
  const m = d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return {
    year,
    n,
    a: scoreYear(year, xs.map((x) => ({ date: x.date, p: x.a, o: x.o }))),
    b: scoreYear(year, xs.map((x) => ({ date: x.date, p: x.b, o: x.o }))),
    diff: m,
    t: m / (sd / Math.sqrt(n)),
  };
}

/** Benjamini–Hochberg（同じ年の中で多数のチームを調べるときの偽発見の制御） */
export function benjaminiHochberg(ps: number[], q = 0.1): boolean[] {
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  let kMax = -1;
  idx.forEach(([p], k) => {
    if (p <= ((k + 1) / ps.length) * q) kMax = k;
  });
  const out = ps.map(() => false);
  for (let k = 0; k <= kMax; k++) out[idx[k]![1]] = true;
  return out;
}

/** 標準正規の両側 p 値 */
export function pTwoSided(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return 1 - erf;
}
