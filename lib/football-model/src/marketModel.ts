/**
 * 2 つ目のモデル: **市場基盤モデル**（`mkt-blend-v1`・2026-10-09 Founder 指示「市場を基盤にして予想する」）。
 *
 * 予想の土台を市場に置き、その上に正準モデル（Dixon-Coles）の情報を足す。ロジットの空間で
 *   s_k = a·log 市場_k + b·log 正準_k + c·[k = 引き分け]   → softmax
 * - a: 市場の確率の自信の度合い（a>1 で本命を強める＝本命・大穴の偏りの補正）
 * - b: 正準モデルの情報をどれだけ足すか（0 なら市場だけ。正なら市場に無い情報を正準が持っている）
 * - c: 引き分けの全体の補正
 * 係数は過去の（市場・正準・結果）から対数損失の最小化（ニュートン法）で決める。
 * 固定の基準では**試合日ごとに 2 日前までの試合だけで当て直し**て年ごとに測る（src/cli/benchmark.ts）。
 * 本番の係数は基準の全期間（〜2026-09-20）で当てた値で、未来の試合にだけ使う。
 *
 * 実測（基準 v1・2026-10-09）: b は毎年**負**（−0.11〜−0.17）。市場が分かっている上では、正準が市場と
 * 食い違う向きの逆に結果が出やすい（正準は市場の持つ情報＝負傷・移籍・先発などを持たない）。
 * 本番の係数は Bet365 のオッズで当てた値で、本番の市場（The Odds API の各社の中央値）とは取得元が違う。
 *
 * 推奨: EV = 確率 × 最良のオッズ − 1 が閾値を超えた結果があれば推奨、無ければ見送り。
 */
import type { ProbabilityTriple } from "./scoring.ts";

export const MKT_MODEL = "mkt-blend-v1";
export interface BlendWeights {
  a: number;
  b: number;
  c: number;
}
/** 本番の係数（`src/cli/benchmark.ts` の「本番の係数」が出す値。基準の全期間で当てた） */
export const MKT_WEIGHTS: BlendWeights = { a: 1.2469, b: -0.1109, c: 0.0976 };
/** 推奨の閾値（EV）。公式記録で EV の帯ごとに答え合わせし、決済 1,000 件の時点で見直す */
export const MKT_EV_THRESHOLD = 0;

const feats = (m: ProbabilityTriple, q: ProbabilityTriple, k: number): [number, number, number] => [
  Math.log(Math.max(m[k]!, 1e-9)),
  Math.log(Math.max(q[k]!, 1e-9)),
  k === 1 ? 1 : 0,
];

export function blend(m: ProbabilityTriple, q: ProbabilityTriple, w: BlendWeights): ProbabilityTriple {
  const s = [0, 1, 2].map((k) => {
    const f = feats(m, q, k);
    return w.a * f[0] + w.b * f[1] + w.c * f[2];
  });
  const mx = Math.max(...s);
  const e = s.map((v) => Math.exp(v - mx));
  const z = e[0]! + e[1]! + e[2]!;
  return [e[0]! / z, e[1]! / z, e[2]! / z];
}

/** 対数損失を最小にする係数（ニュートン法・3 変数。微小なリッジで安定させる） */
export function fitBlend(rows: ReadonlyArray<{ m: ProbabilityTriple; q: ProbabilityTriple; o: 0 | 1 | 2 }>, iters = 8): BlendWeights {
  let w = [1, 0, 0];
  for (let it = 0; it < iters; it++) {
    const g = [0, 0, 0];
    const H = [[1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6]];
    for (const r of rows) {
      const p = blend(r.m, r.q, { a: w[0]!, b: w[1]!, c: w[2]! });
      const F = [0, 1, 2].map((k) => feats(r.m, r.q, k));
      const mean = [0, 1, 2].map((j) => p[0] * F[0]![j]! + p[1] * F[1]![j]! + p[2] * F[2]![j]!);
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) g[j]! += (p[k]! - (r.o === k ? 1 : 0)) * F[k]![j]!;
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) H[i]![j]! += p[0] * F[0]![i]! * F[0]![j]! + p[1] * F[1]![i]! * F[1]![j]! + p[2] * F[2]![i]! * F[2]![j]! - mean[i]! * mean[j]!;
    }
    const step = solve3(H, g);
    w = w.map((v, i) => v - step[i]!);
  }
  return { a: w[0]!, b: w[1]!, c: w[2]! };
}

function solve3(A: number[][], y: number[]): number[] {
  const M = A.map((r, i) => [...r, y[i]!]);
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(M[r]![i]!) > Math.abs(M[piv]![i]!)) piv = r;
    [M[i], M[piv]] = [M[piv]!, M[i]!];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = M[r]![i]! / M[i]![i]!;
      for (let c = i; c < 4; c++) M[r]![c]! -= f * M[i]![c]!;
    }
  }
  return [0, 1, 2].map((i) => M[i]![3]! / M[i]![i]!);
}

export interface MarketModelOutput {
  p: ProbabilityTriple;
  ev: [number, number, number] | null;
  recommend: "H" | "D" | "A" | null;
}

export function marketModel(
  market: ProbabilityTriple,
  canonical: ProbabilityTriple,
  bestOdds: [number, number, number] | null | undefined,
  w: BlendWeights = MKT_WEIGHTS,
): MarketModelOutput {
  const p = blend(market, canonical, w);
  if (!bestOdds || !bestOdds.every((o) => o > 1)) return { p, ev: null, recommend: null };
  const ev: [number, number, number] = [p[0] * bestOdds[0] - 1, p[1] * bestOdds[1] - 1, p[2] * bestOdds[2] - 1];
  let k = -1;
  for (let j = 0; j < 3; j++) if (ev[j]! > MKT_EV_THRESHOLD && (k < 0 || ev[j]! > ev[k]!)) k = j;
  return { p, ev, recommend: k < 0 ? null : (["H", "D", "A"] as const)[k]! };
}
