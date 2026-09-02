/**
 * 3 値予想（勝ち / 引き分け / 負け）の採点。
 *
 * VORTE EV（野球・2 値）の規定「主指標は Brier / log loss。的中率を単独で読まない。
 * 的中率には Wilson 95% 区間を併記する」をサッカーへ移す。
 * 3 値では順序（ホーム勝ち > 引き分け > アウェイ勝ち）があるので、順序を考慮する
 * RPS（ranked probability score）を主指標にし、多値 Brier と log loss を併記する。
 * いずれも小さいほど良い。
 */

/** 0 = ホーム勝ち / 1 = 引き分け / 2 = アウェイ勝ち */
export type Outcome = 0 | 1 | 2;

export type ProbabilityTriple = readonly [home: number, draw: number, away: number];

function check(p: ProbabilityTriple): void {
  const s = p[0] + p[1] + p[2];
  if (Math.abs(s - 1) > 1e-6) throw new Error(`確率の合計が 1 でない: ${s}`);
  for (const x of p) if (x < 0 || x > 1) throw new Error(`確率が [0,1] の外: ${x}`);
}

/** 実際の結果を one-hot にする */
export function outcomeOf(homeGoals: number, awayGoals: number): Outcome {
  return homeGoals > awayGoals ? 0 : homeGoals === awayGoals ? 1 : 2;
}

/**
 * Ranked probability score（K=3）。
 * 累積確率と累積結果の差の二乗和を K-1 で割る。完全な予想で 0、最悪で 1。
 * 「ホーム勝ちを 90% と言って引き分け」は「同じ 90% でアウェイ勝ち」より軽く
 * 罰せられる（順序を見るため）。
 */
export function rps(p: ProbabilityTriple, outcome: Outcome): number {
  check(p);
  const o = [0, 0, 0];
  o[outcome] = 1;
  let cumP = 0;
  let cumO = 0;
  let sum = 0;
  for (let k = 0; k < 2; k++) {
    cumP += p[k];
    cumO += o[k];
    sum += (cumP - cumO) ** 2;
  }
  return sum / 2;
}

/** 多値 Brier（Σ (p_k - o_k)^2）。順序は見ない。一様予想 (1/3,1/3,1/3) で 2/3 */
export function multiclassBrier(p: ProbabilityTriple, outcome: Outcome): number {
  check(p);
  let s = 0;
  for (let k = 0; k < 3; k++) s += (p[k] - (k === outcome ? 1 : 0)) ** 2;
  return s;
}

/** log loss（-log p_actual）。0 確率を言い切って外すと無限大になるので下限で切る */
export function logLoss(p: ProbabilityTriple, outcome: Outcome, floor = 1e-12): number {
  check(p);
  return -Math.log(Math.max(floor, p[outcome]));
}

/** 的中率の Wilson 95% 区間（VORTE EV の backtest.ts と同じ式） */
export function wilson95(k: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export interface ScoreSummary {
  n: number;
  meanRps: number;
  meanBrier: number;
  meanLogLoss: number;
  /** 最大確率の結果が当たった件数 */
  hits: number;
  accuracy: number;
  wilson: { lo: number; hi: number };
}

/** 予想列をまとめて採点する */
export function summarize(
  rows: ReadonlyArray<{ p: ProbabilityTriple; outcome: Outcome }>,
): ScoreSummary {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, meanRps: NaN, meanBrier: NaN, meanLogLoss: NaN, hits: 0, accuracy: NaN, wilson: { lo: 0, hi: 0 } };
  }
  let r = 0;
  let b = 0;
  let l = 0;
  let hits = 0;
  for (const { p, outcome } of rows) {
    r += rps(p, outcome);
    b += multiclassBrier(p, outcome);
    l += logLoss(p, outcome);
    const argmax = p[0] >= p[1] && p[0] >= p[2] ? 0 : p[1] >= p[2] ? 1 : 2;
    if (argmax === outcome) hits++;
  }
  return {
    n,
    meanRps: r / n,
    meanBrier: b / n,
    meanLogLoss: l / n,
    hits,
    accuracy: hits / n,
    wilson: wilson95(hits, n),
  };
}
