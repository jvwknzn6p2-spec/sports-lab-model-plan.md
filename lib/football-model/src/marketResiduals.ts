/**
 * 市場基盤モデルの土台: 「市場の予想と結果がなぜ食い違うか」を測る（2026-10-10・Founder 承認 A）。
 *
 * 試合の結果 = 本当の確率 + 偶然、市場の予想 = 本当の確率 + 市場の誤り。
 * 市場が外れた試合のうち**市場の誤り**の分には原因があり、試合前に観測できる情報から
 * 「市場がどちらへずれるか」を、まだ見ていない試合でも当てられるはずである。偶然の分は当てられない。
 *
 * 見分け方は 1 つだけ: **前半の期間で見つけたずれが、後半の期間でも再現するか**。
 * 仮説・特徴量・判定の基準はこのファイルで先に固定し、後半を見てから変えない。
 *
 * 特徴量は全て**その試合より前の試合だけ**から作る（ウォークフォワード）。リークがあると全てが嘘になる。
 */
import type { HistoryRow } from "./history.ts";
import { rps, type Outcome, type ProbabilityTriple } from "./scoring.ts";

/** 控除（ブックの上乗せ）を除いた市場確率。正規化で割り戻す（各結果に比例して控除が乗っている前提） */
export function devig(odds: { home: number; draw: number; away: number }): ProbabilityTriple {
  const inv = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const s = inv[0]! + inv[1]! + inv[2]!;
  return [inv[0]! / s, inv[1]! / s, inv[2]! / s];
}

export const outcomeOfGoals = (h: number, a: number): Outcome => (h > a ? 0 : h === a ? 1 : 2);

/** 1 試合ぶんの観測（市場・結果・試合前に分かっていた特徴量） */
export interface MarketObs {
  league: string;
  date: string;
  home: string;
  away: string;
  market: ProbabilityTriple;
  odds: [number, number, number];
  outcome: Outcome;
  /** 直近 LUCK_WINDOW 試合の「結果 − 内容」（ホーム − アウェイ）。枠内シュートが揃わなければ null */
  luckDiff: number | null;
  /** 前の試合からの日数の差（ホーム − アウェイ・±REST_CLIP 日で切る）。どちらかが初出なら null */
  restDiff: number | null;
}

/** 仮説 H2 の窓（直近の試合数）。後半を見る前に固定 */
export const LUCK_WINDOW = 3;
/** 仮説 H4 の切り捨て幅（日） */
export const REST_CLIP = 3;

/**
 * 履歴（1 リーグ分）から観測を作る。**ウォークフォワード**: 各試合の特徴量は、その試合の日付より前の
 * 試合だけから作る（同じ日の試合は互いに使わない）。
 *
 * 「運」の定義（H2）: 1 試合の (得失点差) − c × (枠内シュートの差)。c はシュート 1 本あたりの得点
 * （`conversion`・前半の期間から推定して渡す）。内容（枠内シュート）のわりに点が入った＝プラス。
 */
export function buildObservations(rows: HistoryRow[], conversion: number): MarketObs[] {
  const sorted = [...rows].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  const lastDate = new Map<string, string>();
  const luckHist = new Map<string, Array<number | null>>();
  const out: MarketObs[] = [];
  let i = 0;
  while (i < sorted.length) {
    // 同じ日の試合をまとめて扱い、特徴量を先に全部作ってから履歴を更新する
    let j = i;
    while (j < sorted.length && sorted[j]!.date === sorted[i]!.date) j++;
    const day = sorted.slice(i, j);
    for (const r of day) {
      if (!r.odds || !(r.odds.home > 1 && r.odds.draw > 1 && r.odds.away > 1)) continue;
      const luck = (t: string): number | null => {
        const h = luckHist.get(t) ?? [];
        if (h.length < LUCK_WINDOW) return null;
        const w = h.slice(-LUCK_WINDOW);
        if (w.some((x) => x === null)) return null;
        return (w as number[]).reduce((a, b) => a + b, 0);
      };
      const lh = luck(r.home);
      const la = luck(r.away);
      const days = (t: string): number | null => {
        const d = lastDate.get(t);
        return d === undefined ? null : (Date.parse(r.date) - Date.parse(d)) / 86_400_000;
      };
      const rh = days(r.home);
      const ra = days(r.away);
      out.push({
        league: r.division,
        date: r.date,
        home: r.home,
        away: r.away,
        market: devig(r.odds),
        odds: [r.odds.home, r.odds.draw, r.odds.away],
        outcome: outcomeOfGoals(r.homeGoals, r.awayGoals),
        luckDiff: lh === null || la === null ? null : lh - la,
        restDiff: rh === null || ra === null ? null : Math.max(-REST_CLIP, Math.min(REST_CLIP, rh - ra)),
      });
    }
    for (const r of day) {
      const gd = r.homeGoals - r.awayGoals;
      const luckHome = r.sot ? gd - conversion * (r.sot.home - r.sot.away) : null;
      for (const [t, v] of [
        [r.home, luckHome],
        [r.away, luckHome === null ? null : -luckHome],
      ] as const) {
        const h = luckHist.get(t) ?? [];
        h.push(v);
        luckHist.set(t, h);
        lastDate.set(t, r.date);
      }
    }
    i = j;
  }
  return out;
}

/** 補正の係数。γ = 市場確率を何乗するか（>1 で本命を強める＝本命・大穴バイアスの補正）、b = 特徴量の効き */
export interface Adjust {
  gamma: number;
  b: number;
}

/**
 * 市場確率を補正する。ロジットの空間で s_k = γ·log p_k、ホーム勝に +b·x・アウェイ勝に −b·x を足して
 * 正規化する（x はホーム − アウェイの特徴量差）。γ=1, b=0 なら市場そのもの。
 */
export function adjust(p: ProbabilityTriple, x: number, a: Adjust): ProbabilityTriple {
  const s = [a.gamma * Math.log(p[0]) + a.b * x, a.gamma * Math.log(p[1]), a.gamma * Math.log(p[2]) - a.b * x];
  const m = Math.max(...s);
  const e = s.map((v) => Math.exp(v - m));
  const z = e[0]! + e[1]! + e[2]!;
  return [e[0]! / z, e[1]! / z, e[2]! / z];
}

const logLoss = (p: ProbabilityTriple, o: Outcome): number => -Math.log(Math.max(p[o], 1e-12));

/**
 * 前半の期間で係数を当てはめる（対数損失の最小化・格子探索）。格子は粗くてよい
 * （効くかどうかを見るのが目的で、小数点以下の最適化は後半で崩れる）。
 */
export function fitAdjust(obs: MarketObs[], feature: (o: MarketObs) => number | null, fitB: boolean): Adjust {
  let best: Adjust = { gamma: 1, b: 0 };
  let bestLoss = Infinity;
  const gammas: number[] = [];
  for (let g = 0.8; g <= 1.4001; g += 0.01) gammas.push(+g.toFixed(2));
  const bs: number[] = [];
  if (fitB) for (let b = -0.3; b <= 0.30001; b += 0.01) bs.push(+b.toFixed(2));
  else bs.push(0);
  for (const gamma of gammas)
    for (const b of bs) {
      let loss = 0;
      for (const o of obs) loss += logLoss(adjust(o.market, feature(o) ?? 0, { gamma, b }), o.outcome);
      if (loss < bestLoss) {
        bestLoss = loss;
        best = { gamma, b };
      }
    }
  return best;
}

export interface Verdict {
  n: number;
  /** 補正後 − 市場 の平均 RPS（負なら補正が良い） */
  meanDiff: number;
  /** ペアの差の t 値 */
  t: number;
  /** 判定: 後半で RPS が下がり、かつ t ≤ −1.645（片側 5%）なら「再現した」 */
  replicated: boolean;
}

/** 後半の期間で、補正した確率と市場をペアで比べる（同じ試合集合・RPS） */
export function evaluate(obs: MarketObs[], feature: (o: MarketObs) => number | null, a: Adjust): Verdict {
  const d = obs.map((o) => rps(adjust(o.market, feature(o) ?? 0, a), o.outcome) - rps(o.market, o.outcome));
  const n = d.length;
  const m = d.reduce((x, y) => x + y, 0) / n;
  const v = d.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1);
  const t = m / Math.sqrt(v / n);
  return { n, meanDiff: m, t, replicated: m < 0 && t <= -1.645 };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 最良のオッズで買えたら（取得元の生 CSV・試合前の Max/Avg/Pinnacle と締切直前の Pinnacle）
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PriceRow {
  season: string;
  division: string;
  outcome: Outcome;
  /** 試合前の Pinnacle / 平均 / 最高値（H, D, A） */
  ps: [number, number, number];
  avg: [number, number, number];
  max: [number, number, number];
  /** 締切直前の Pinnacle（無い試合は null） */
  psClose: [number, number, number] | null;
}

/** football-data.co.uk の CSV 1 本を読む（Pinnacle・平均・最高値が揃った試合だけ） */
export function parsePriceCsv(text: string, division: string, season: string): PriceRow[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const head = lines[0]!.split(",");
  const ix = (k: string): number => head.indexOf(k);
  const out: PriceRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const num = (k: string): number => (ix(k) >= 0 ? parseFloat(c[ix(k)] ?? "") : NaN);
    const trip = (a: string, b: string, d: string): [number, number, number] => [num(a), num(b), num(d)];
    const hg = num("FTHG");
    const ag = num("FTAG");
    if (!(hg >= 0 && ag >= 0)) continue;
    const ps = trip("PSH", "PSD", "PSA");
    const avg = trip("AvgH", "AvgD", "AvgA");
    const max = trip("MaxH", "MaxD", "MaxA");
    if (![...ps, ...avg, ...max].every((x) => x > 1)) continue;
    const psc = trip("PSCH", "PSCD", "PSCA");
    out.push({ season, division, outcome: outcomeOfGoals(hg, ag), ps, avg, max, psClose: psc.every((x) => x > 1) ? psc : null });
  }
  return out;
}

export const devigTriple = (o: [number, number, number]): ProbabilityTriple => devig({ home: o[0], draw: o[1], away: o[2] });

/** γ だけを当てはめる（対数損失の最小化） */
export function fitGamma(rows: Array<{ p: ProbabilityTriple; outcome: Outcome }>): number {
  let best = 1;
  let bestLoss = Infinity;
  for (let g = 0.8; g <= 1.4001; g += 0.01) {
    const gamma = +g.toFixed(2);
    let loss = 0;
    for (const r of rows) loss += logLoss(adjust(r.p, 0, { gamma, b: 0 }), r.outcome);
    if (loss < bestLoss) {
      bestLoss = loss;
      best = gamma;
    }
  }
  return best;
}

export interface BetSummary {
  n: number;
  roi: number;
  t: number;
  /** 買った価格 ÷ 締切直前の Pinnacle − 1 の平均（CLV）。締切値が無い試合は除く */
  clv: number | null;
}

/** 補正後の確率 × 最高値 − 1 > threshold の結果を 1 単位ずつ買った場合 */
export function bestPriceBets(rows: PriceRow[], base: "ps" | "avg", gamma: number, threshold: number): BetSummary {
  const pl: number[] = [];
  const clv: number[] = [];
  for (const r of rows) {
    const p = adjust(devigTriple(r[base]), 0, { gamma, b: 0 });
    for (let j = 0; j < 3; j++) {
      if (p[j]! * r.max[j]! - 1 <= threshold) continue;
      pl.push(r.outcome === j ? r.max[j]! - 1 : -1);
      if (r.psClose) clv.push(r.max[j]! / r.psClose[j]! - 1);
    }
  }
  const n = pl.length;
  if (n === 0) return { n: 0, roi: 0, t: 0, clv: null };
  const m = pl.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(pl.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(n - 1, 1));
  return { n, roi: m, t: m / (sd / Math.sqrt(n)), clv: clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null };
}
