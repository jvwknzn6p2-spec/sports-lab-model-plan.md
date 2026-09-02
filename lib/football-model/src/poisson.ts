/**
 * 二独立ポアソン + Dixon-Coles 低得点補正によるスコア分布。
 *
 * サッカーの 1 試合は「ホームの得点 ~ Poisson(λ)」「アウェイの得点 ~ Poisson(μ)」で
 * 近似でき、勝ち・引き分け・負け（W/D/L）と任意のスコア確率が同じ行列から出る。
 * 独立ポアソンは 0-0 / 1-1 を過小、1-0 / 0-1 を過大に見積もることが知られており、
 * Dixon & Coles (1997) の τ 補正（パラメータ ρ・実データでは概ね -0.05〜-0.15）で
 * 低得点 4 マスだけを補正する。
 *
 * 純関数のみ。乱数・I/O・日付は扱わない。
 */

/** Poisson(λ) の確率質量 P(X = k) */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // log 空間で計算して大きな k でも桁落ちしないようにする
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(-lambda + k * Math.log(lambda) - logFact);
}

/** Dixon-Coles の τ(h, a)。ρ = 0 なら常に 1（独立ポアソンと一致） */
export function dixonColesTau(h: number, a: number, lambda: number, mu: number, rho: number): number {
  if (h === 0 && a === 0) return 1 - lambda * mu * rho;
  if (h === 1 && a === 0) return 1 + mu * rho;
  if (h === 0 && a === 1) return 1 + lambda * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

export interface ScoreMatrixOptions {
  /** 打ち切る最大得点（両軍とも）。既定 10。それ以上はほぼ 0 */
  maxGoals?: number;
  /** Dixon-Coles の ρ。既定 0（独立ポアソン） */
  rho?: number;
}

/**
 * スコア行列 P[h][a]（h = ホーム得点、a = アウェイ得点、0..maxGoals）。
 * 打ち切りぶんは全体を再正規化して合計 1 にする。
 * ρ が τ を負にするような極端な値は、負の確率を作らないよう 0 に切り上げる。
 */
export function scoreMatrix(lambda: number, mu: number, opts: ScoreMatrixOptions = {}): number[][] {
  const max = opts.maxGoals ?? 10;
  const rho = opts.rho ?? 0;
  if (!(lambda > 0) || !(mu > 0)) throw new Error(`λ, μ は正でなければならない（λ=${lambda}, μ=${mu}）`);
  const ph = Array.from({ length: max + 1 }, (_, k) => poissonPmf(k, lambda));
  const pa = Array.from({ length: max + 1 }, (_, k) => poissonPmf(k, mu));
  const m: number[][] = [];
  let total = 0;
  for (let h = 0; h <= max; h++) {
    const row: number[] = [];
    for (let a = 0; a <= max; a++) {
      const v = Math.max(0, ph[h] * pa[a] * dixonColesTau(h, a, lambda, mu, rho));
      row.push(v);
      total += v;
    }
    m.push(row);
  }
  for (const row of m) for (let a = 0; a < row.length; a++) row[a] /= total;
  return m;
}

export interface OutcomeProbabilities {
  home: number;
  draw: number;
  away: number;
}

/** W/D/L 確率（行列の上三角・対角・下三角の和） */
export function outcomeProbabilities(m: number[][]): OutcomeProbabilities {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h < m.length; h++) {
    for (let a = 0; a < m[h].length; a++) {
      if (h > a) home += m[h][a];
      else if (h === a) draw += m[h][a];
      else away += m[h][a];
    }
  }
  return { home, draw, away };
}

export interface Scoreline {
  home: number;
  away: number;
  probability: number;
}

/** 確率の高い順に n 件のスコア */
export function topScorelines(m: number[][], n = 5): Scoreline[] {
  const all: Scoreline[] = [];
  for (let h = 0; h < m.length; h++) {
    for (let a = 0; a < m[h].length; a++) all.push({ home: h, away: a, probability: m[h][a] });
  }
  all.sort((x, y) => y.probability - x.probability || x.home + x.away - (y.home + y.away));
  return all.slice(0, n);
}

/** 行列から見た期待得点（打ち切り・τ 補正込み。λ, μ とはわずかにずれる） */
export function expectedGoals(m: number[][]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (let h = 0; h < m.length; h++) {
    for (let a = 0; a < m[h].length; a++) {
      home += h * m[h][a];
      away += a * m[h][a];
    }
  }
  return { home, away };
}

/** 両チーム得点の確率 */
export function bothTeamsScore(m: number[][]): number {
  let p = 0;
  for (let h = 1; h < m.length; h++) for (let a = 1; a < m[h].length; a++) p += m[h][a];
  return p;
}

/** 総得点が line を上回る確率（line = 2.5 なら 3 点以上） */
export function overTotal(m: number[][], line: number): number {
  let p = 0;
  for (let h = 0; h < m.length; h++) {
    for (let a = 0; a < m[h].length; a++) if (h + a > line) p += m[h][a];
  }
  return p;
}
