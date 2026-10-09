/**
 * 2 つ目のモデル: **市場補正モデル**（`mkt-flb-v1`・2026-10-10 Founder 承認 B）。
 *
 * 予想の土台を市場に置き、市場が系統的にずれる所だけを直す。正準モデル（チームの強さから組み立てる
 * Dixon-Coles）とは別の考え方で、同じ試合・同じ封緘・同じ指標で並べて記録し、強みと弱みを比べる。
 *
 * 1. 市場を読む: 各ブックの控除を除いた確率の中央値（oddsApi.ts の `market`）
 * 2. 補正する: 本命・大穴バイアス。市場確率を γ 乗して正規化（γ>1 で本命を強め大穴を弱める）
 * 3. 判定する: EV = 補正後の確率 × 最良のオッズ − 1。閾値を超えた結果があれば推奨、無ければ見送り
 *
 * 係数は取得元の生 CSV で前半（23/24・24/25）に当てはめ、後半（25/26）で確かめた値
 * （marketResiduals.ts・`src/cli/residuals.ts` で再現できる）:
 * - 土台＝平均のオッズのとき γ = 1.11
 * - 補正なしで「得に見える」結果を最高値で買うと後半 −21.6%（得に見えるのはほとんど大穴）
 * - γ=1.11 で補正し最高値で買うと後半 +1.1%（n=589・t=0.29）。**損益ゼロ付近で、有意ではない**
 * つまり推奨が儲かる保証は無い。全件を記録し、EV の帯ごとに答え合わせして閾値を学ぶための器である。
 *
 * 試合ごとの特徴量（直近の運・休養差）は、検証で再現しなかったので**入れない**（marketResiduals.ts の H2/H4）。
 */
import { adjust } from "./marketResiduals.ts";
import type { ProbabilityTriple } from "./scoring.ts";

export const MKT_MODEL = "mkt-flb-v1";
/** 本命・大穴バイアスの補正。取得元 CSV の前半で、平均のオッズを土台に当てはめた値 */
export const MKT_GAMMA = 1.11;
/**
 * 推奨の閾値（EV）。検証では閾値を上げるほど件数が減って不安定になり、0 だけが前半・後半とも
 * 損益ゼロ付近に収まった。**後半を見て選んだ値なので、これ自体はまだ検証済みではない**。
 * 公式記録で EV の帯（0〜2%・2〜5%・5% 以上）ごとに答え合わせし、決済 1,000 件の時点で見直す
 */
export const MKT_EV_THRESHOLD = 0;

export interface MarketModelOutput {
  p: ProbabilityTriple;
  ev: [number, number, number] | null;
  recommend: "H" | "D" | "A" | null;
}

export function marketModel(market: ProbabilityTriple, bestOdds: [number, number, number] | null | undefined): MarketModelOutput {
  const p = adjust(market, 0, { gamma: MKT_GAMMA, b: 0 });
  if (!bestOdds || !bestOdds.every((o) => o > 1)) return { p, ev: null, recommend: null };
  const ev: [number, number, number] = [p[0] * bestOdds[0] - 1, p[1] * bestOdds[1] - 1, p[2] * bestOdds[2] - 1];
  let k = -1;
  for (let j = 0; j < 3; j++) if (ev[j]! > MKT_EV_THRESHOLD && (k < 0 || ev[j]! > ev[k]!)) k = j;
  return { p, ev, recommend: k < 0 ? null : (["H", "D", "A"] as const)[k]! };
}
