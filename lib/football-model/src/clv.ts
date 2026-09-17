/**
 * CLV（Closing Line Value）— **モデルにエッジがあるかを、結果とは独立に測る器**。
 *
 * 考え方: モデルが「市場より高い」と見た結果について、市場が発行時点からキックオフ直前
 * までにこちら側へ動いたかを見る。動いていれば、モデルは市場が**後から織り込む情報**を
 * 先に持っていたことになる。的中率や RPS と違い、**1 試合ごとの勝ち負けの運に左右されない**
 * ので、少ない標本でもエッジの有無を早く判別できる（野球側 VORTE EV で 2026-08-28 に
 * 同じ器を使い、推奨側の含意勝率が quote→closing で平均 +1.41pp・正方向 68.5% だった）。
 *
 * **サッカーの実測（2026-09-17・決済済み 151 件）: 平均 +0.16pp・正方向 54%・t=+1.85。**
 * 符号は正だが野球の 1/9 の大きさで、有意ではない。RPS の対照（モデル 0.2098 対
 * 市場 0.2010）と整合し、**このモデルに market を超えるエッジがあるとは言えない**。
 * よってハンデの EV は依然として計算してはならない（football/README.md の「既知の限界」）。
 *
 * ここは測るだけで、賭けの推奨も EV も出さない。
 */
import type { LedgerEvaluation, LedgerPrediction } from "./ledger.ts";
import type { ClosingMarketResolver } from "./marketSnapshots.ts";
import { wilson95 } from "./scoring.ts";

export interface ClvEntry {
  predictionId: string;
  providerId: string;
  league: string;
  kickoffAt: string;
  /** モデルが市場より最も高く見た結果（0=ホーム勝 / 1=引分 / 2=アウェイ勝） */
  side: 0 | 1 | 2;
  /** その結果のモデル確率 − 発行時点の市場確率（pp） */
  edgePp: number;
  /** その結果の 直前市場 − 発行時点市場（pp）。正なら市場がモデル側へ動いた */
  movePp: number;
  closingFetchedAt: string;
}

export interface ClvSummary {
  n: number;
  /** movePp の平均 */
  meanMovePp: number;
  /** 標準誤差と t 値（帰無仮説 平均 0） */
  sePp: number;
  t: number;
  /** 正方向に動いた件数とその Wilson 95% 区間 */
  positive: number;
  positiveRate: number;
  positiveCi: { lo: number; hi: number };
  /** 参考: モデルが見たエッジの平均（pp） */
  meanEdgePp: number;
}

/**
 * 発行時点と直前の市場が**両方ある**予想だけを対象にする。片方でも欠けたら
 * 推測で埋めず単に対象外にする（台帳の規律と同じ）。
 *
 * `side` は「モデル − 発行時点市場」が最大の結果。差が 0 以下（モデルがどの結果についても
 * 市場より高く見ていない）試合は**エッジを主張していない**ので対象外。
 */
export function clvEntries(
  predictions: LedgerPrediction[],
  evaluations: LedgerEvaluation[],
  closingMarket: ClosingMarketResolver,
): ClvEntry[] {
  const settled = new Set(evaluations.map((e) => e.predictionId));
  const out: ClvEntry[] = [];
  for (const p of predictions) {
    if (!settled.has(p.id)) continue; // 未決済は「直前」がまだ確定していない場合がある
    if (!p.market) continue;
    const closing = closingMarket(p.providerId, p.kickoffAt);
    if (!closing) continue;
    const model: [number, number, number] = [p.pHome, p.pDraw, p.pAway];
    let side: 0 | 1 | 2 = 0;
    for (const k of [1, 2] as const) if (model[k] - p.market[k] > model[side] - p.market[side]) side = k;
    const edgePp = (model[side] - p.market[side]) * 100;
    if (edgePp <= 0) continue;
    out.push({
      predictionId: p.id,
      providerId: p.providerId,
      league: p.league,
      kickoffAt: p.kickoffAt,
      side,
      edgePp,
      movePp: (closing.market[side] - p.market[side]) * 100,
      closingFetchedAt: closing.fetchedAt,
    });
  }
  return out.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
}

/** n<2 では t が定義できないので 0 を返す（「有意」と読ませないため） */
export function summarizeClv(entries: ClvEntry[]): ClvSummary {
  const n = entries.length;
  if (n === 0) {
    return { n: 0, meanMovePp: 0, sePp: 0, t: 0, positive: 0, positiveRate: 0, positiveCi: { lo: 0, hi: 0 }, meanEdgePp: 0 };
  }
  const moves = entries.map((e) => e.movePp);
  const mean = moves.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? moves.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const se = n > 1 ? Math.sqrt(variance / n) : 0;
  const positive = entries.filter((e) => e.movePp > 0).length;
  return {
    n,
    meanMovePp: mean,
    sePp: se,
    t: se > 0 ? mean / se : 0,
    positive,
    positiveRate: positive / n,
    positiveCi: wilson95(positive, n),
    meanEdgePp: entries.reduce((s, e) => s + e.edgePp, 0) / n,
  };
}
