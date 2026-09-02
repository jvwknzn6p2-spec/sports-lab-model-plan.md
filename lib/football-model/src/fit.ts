/**
 * Dixon-Coles モデルの最尤推定（時間減衰つき）と試合予測。
 *
 *   λ（ホーム得点率）= exp(attack_home + defense_away + homeAdvantage)
 *   μ（アウェイ得点率）= exp(attack_away + defense_home)
 *   P(h, a) = Poisson(h; λ) Poisson(a; μ) τ(h, a; λ, μ, ρ)
 *
 * 目的関数は重み付き対数尤度 Σ w_i log P(h_i, a_i)。重みは
 * w = exp(-ξ · 経過日数) で古い試合ほど軽い（Dixon & Coles 1997 の φ）。
 * 勾配は解析的に求め、単純な勾配上昇（学習率の自動調整つき）で解く。
 * 外部依存なし・決定的（同じ入力から同じ出力）。
 *
 * リーク防止: `asOf` を渡すと、その時刻**より前**に始まった試合だけを使う。
 * ウォークフォワード評価（evaluate.ts）はこれを毎試合日に呼ぶ。
 */
import { dixonColesTau, expectedGoals, outcomeProbabilities, scoreMatrix, topScorelines, bothTeamsScore, overTotal } from "./poisson.ts";
import type { OutcomeProbabilities, Scoreline } from "./poisson.ts";

export interface MatchRecord {
  /** 開始時刻（ISO 8601）。並び順・重み・リーク判定の基準 */
  date: string;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

export interface FitOptions {
  /** 時間減衰 ξ（1 日あたり）。既定 0.0065（半減期 ≈ 107 日） */
  xi?: number;
  /** この時刻より前の試合だけを学習に使う。省略時は全試合・重みの基準は最新試合 */
  asOf?: string;
  /** ρ も推定するか。既定 true。false なら ρ = 0（独立ポアソン） */
  fitRho?: boolean;
  maxIter?: number;
  /** 対数尤度の改善がこれ未満になったら停止（重み合計で正規化した値） */
  tol?: number;
}

export interface FitResult {
  teams: string[];
  attack: Record<string, number>;
  defense: Record<string, number>;
  homeAdvantage: number;
  rho: number;
  logLikelihood: number;
  iterations: number;
  nMatches: number;
  weightSum: number;
  xi: number;
  asOf: string | null;
}

const DAY_MS = 86_400_000;
const RHO_LIMIT = 0.4;

function logFactorial(k: number): number {
  let s = 0;
  for (let i = 2; i <= k; i++) s += Math.log(i);
  return s;
}

/** 重み付き対数尤度とその勾配 */
function evaluate(
  rows: Array<{ h: number; a: number; w: number; hi: number; ai: number }>,
  attack: Float64Array,
  defense: Float64Array,
  gamma: number,
  rho: number,
): { ll: number; gAttack: Float64Array; gDefense: Float64Array; gGamma: number; gRho: number } {
  const T = attack.length;
  const gAttack = new Float64Array(T);
  const gDefense = new Float64Array(T);
  let gGamma = 0;
  let gRho = 0;
  let ll = 0;
  for (const r of rows) {
    const lambda = Math.exp(attack[r.hi] + defense[r.ai] + gamma);
    const mu = Math.exp(attack[r.ai] + defense[r.hi]);
    const tau = Math.max(1e-9, dixonColesTau(r.h, r.a, lambda, mu, rho));
    ll +=
      r.w *
      (-lambda + r.h * Math.log(lambda) - logFactorial(r.h) - mu + r.a * Math.log(mu) - logFactorial(r.a) + Math.log(tau));
    // ポアソン部分（λ に効く: attack_home / defense_away / γ、μ に効く: attack_away / defense_home）
    let dLambda = r.h - lambda; // ∂/∂log λ
    let dMu = r.a - mu;
    // τ 部分
    if (r.h === 0 && r.a === 0) {
      const c = (-lambda * mu * rho) / tau;
      dLambda += c;
      dMu += c;
      gRho += (r.w * -lambda * mu) / tau;
    } else if (r.h === 1 && r.a === 0) {
      dMu += (mu * rho) / tau;
      gRho += (r.w * mu) / tau;
    } else if (r.h === 0 && r.a === 1) {
      dLambda += (lambda * rho) / tau;
      gRho += (r.w * lambda) / tau;
    } else if (r.h === 1 && r.a === 1) {
      gRho += (r.w * -1) / tau;
    }
    gAttack[r.hi] += r.w * dLambda;
    gDefense[r.ai] += r.w * dLambda;
    gGamma += r.w * dLambda;
    gAttack[r.ai] += r.w * dMu;
    gDefense[r.hi] += r.w * dMu;
  }
  return { ll, gAttack, gDefense, gGamma, gRho };
}

/**
 * 最尤推定。試合が 1 件も無い・チームが 2 未満なら例外（黙って既定値を返さない）。
 */
export function fitDixonColes(matches: ReadonlyArray<MatchRecord>, opts: FitOptions = {}): FitResult {
  const xi = opts.xi ?? 0.0065;
  const fitRho = opts.fitRho ?? true;
  const maxIter = opts.maxIter ?? 3000;
  const tol = opts.tol ?? 1e-9;

  const asOfMs = opts.asOf ? Date.parse(opts.asOf) : NaN;
  if (opts.asOf && Number.isNaN(asOfMs)) throw new Error(`asOf を解釈できない: ${opts.asOf}`);
  const used = matches.filter((m) => {
    const t = Date.parse(m.date);
    if (Number.isNaN(t)) throw new Error(`date を解釈できない: ${m.date}`);
    return opts.asOf ? t < asOfMs : true;
  });
  if (used.length === 0) throw new Error("学習に使える試合が無い");
  const refMs = opts.asOf ? asOfMs : Math.max(...used.map((m) => Date.parse(m.date)));

  const teams = [...new Set(used.flatMap((m) => [m.home, m.away]))].sort();
  if (teams.length < 2) throw new Error("チームが 2 未満");
  const index = new Map(teams.map((t, i) => [t, i]));
  const rows = used.map((m) => ({
    h: m.homeGoals,
    a: m.awayGoals,
    w: Math.exp((-xi * (refMs - Date.parse(m.date))) / DAY_MS),
    hi: index.get(m.home)!,
    ai: index.get(m.away)!,
  }));
  for (const r of rows) {
    if (!Number.isInteger(r.h) || !Number.isInteger(r.a) || r.h < 0 || r.a < 0) {
      throw new Error(`得点が非負整数でない: ${r.h}-${r.a}`);
    }
  }
  const weightSum = rows.reduce((s, r) => s + r.w, 0);

  // 初期値: 平均得点から
  const meanHome = rows.reduce((s, r) => s + r.w * r.h, 0) / weightSum;
  const meanAway = rows.reduce((s, r) => s + r.w * r.a, 0) / weightSum;
  const T = teams.length;
  let attack = new Float64Array(T);
  let defense = new Float64Array(T).fill(Math.log(Math.max(meanAway, 0.05)));
  let gamma = Math.log(Math.max(meanHome, 0.05) / Math.max(meanAway, 0.05));
  let rho = 0;

  let lr = 0.5;
  let cur = evaluate(rows, attack, defense, gamma, rho);
  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    const step = lr / weightSum;
    const nAttack = new Float64Array(T);
    const nDefense = new Float64Array(T);
    for (let i = 0; i < T; i++) {
      nAttack[i] = attack[i] + step * cur.gAttack[i];
      nDefense[i] = defense[i] + step * cur.gDefense[i];
    }
    // 識別性: Σ attack = 0（定数の移動は defense が吸収する）
    const meanAttack = nAttack.reduce((s, x) => s + x, 0) / T;
    for (let i = 0; i < T; i++) {
      nAttack[i] -= meanAttack;
      nDefense[i] += meanAttack;
    }
    const nGamma = gamma + step * cur.gGamma;
    const nRho = fitRho ? Math.max(-RHO_LIMIT, Math.min(RHO_LIMIT, rho + step * cur.gRho)) : 0;
    const next = evaluate(rows, nAttack, nDefense, nGamma, nRho);
    if (next.ll >= cur.ll) {
      const gain = (next.ll - cur.ll) / weightSum;
      attack = nAttack;
      defense = nDefense;
      gamma = nGamma;
      rho = nRho;
      cur = next;
      lr = Math.min(lr * 1.1, 4);
      if (gain < tol) {
        iterations++;
        break;
      }
    } else {
      lr *= 0.5;
      if (lr < 1e-8) break;
    }
  }

  const attackRec: Record<string, number> = {};
  const defenseRec: Record<string, number> = {};
  teams.forEach((t, i) => {
    attackRec[t] = attack[i];
    defenseRec[t] = defense[i];
  });
  return {
    teams,
    attack: attackRec,
    defense: defenseRec,
    homeAdvantage: gamma,
    rho,
    logLikelihood: cur.ll,
    iterations,
    nMatches: used.length,
    weightSum,
    xi,
    asOf: opts.asOf ?? null,
  };
}

export interface MatchPrediction {
  home: string;
  away: string;
  lambda: number;
  mu: number;
  outcome: OutcomeProbabilities;
  scorelines: Scoreline[];
  expectedGoals: { home: number; away: number };
  bothTeamsScore: number;
  over25: number;
  matrix: number[][];
}

/** 学習済みモデルで 1 試合を予測する。未知のチームは例外（中立値で埋めない） */
export function predictMatch(
  fit: FitResult,
  home: string,
  away: string,
  opts: { maxGoals?: number; scorelines?: number } = {},
): MatchPrediction {
  if (!(home in fit.attack)) throw new Error(`未知のチーム: ${home}`);
  if (!(away in fit.attack)) throw new Error(`未知のチーム: ${away}`);
  const lambda = Math.exp(fit.attack[home] + fit.defense[away] + fit.homeAdvantage);
  const mu = Math.exp(fit.attack[away] + fit.defense[home]);
  const matrix = scoreMatrix(lambda, mu, { maxGoals: opts.maxGoals ?? 10, rho: fit.rho });
  return {
    home,
    away,
    lambda,
    mu,
    outcome: outcomeProbabilities(matrix),
    scorelines: topScorelines(matrix, opts.scorelines ?? 5),
    expectedGoals: expectedGoals(matrix),
    bothTeamsScore: bothTeamsScore(matrix),
    over25: overTotal(matrix, 2.5),
    matrix,
  };
}
