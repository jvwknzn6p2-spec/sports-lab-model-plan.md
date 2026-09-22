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
  /**
   * 枠内シュート（あれば）。**既定の学習には使わない**。
   * `walkForward` の `shotWeight` を 0 より大きくしたときだけ効く測定用の入力で、
   * 0 のときは本番と 1 ビットも変わらない。
   */
  homeSot?: number;
  awaySot?: number;
}

export interface FitOptions {
  /** 時間減衰 ξ（1 日あたり）。既定 0.0065（半減期 ≈ 107 日） */
  xi?: number;
  /** この時刻より前の試合だけを学習に使う。省略時は全試合・重みの基準は最新試合 */
  asOf?: string;
  /** ρ も推定するか。既定 true。false なら ρ = 0（独立ポアソン） */
  fitRho?: boolean;
  /**
   * 攻撃力・守備力を**リーグ平均へ**縮小する L2 罰則の係数 α。既定 0（＝罰則なし）。
   *
   * 目的関数は `Σ w·logP − α[Σ(aᵢ−ā)² + Σ(dᵢ−d̄)²]`。階層ベイズ（Baio & Blangiardo
   * 2010 型）の MAP 近似にあたり、標本の薄いチームほど強く平均へ寄る（部分プーリング）。
   *
   * **0 へではなく平均へ縮小する。** 識別性の制約は `Σattack = 0` だけで、守備力の
   * 平均はリーグ全体の失点水準を担っている。0 へ縮小するとその水準ごと下げてしまう。
   *
   * α は絶対値で、尤度側は重み合計に比例して大きくなる。よってデータが増えるほど
   * 罰則の相対的な効きは自然に弱まる（事前分布が固定で尤度が育つのと同じ）。
   */
  ridge?: number;
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
  /** 重み付き対数尤度（罰則を含まない生の値） */
  logLikelihood: number;
  /** 適用した L2 罰則の係数 α（0 なら罰則なし） */
  ridge: number;
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

/**
 * 重み付き対数尤度・罰則つき目的関数・その勾配。
 *
 * `obj = ll − α[Σ(aᵢ−ā)² + Σ(dᵢ−d̄)²]`。Σ(xᵢ−x̄)² の xⱼ による偏微分は
 * `2(xⱼ−x̄)`（Σ(xᵢ−x̄)=0 なので平均項が消える）。最大化なので勾配から引く。
 */
function evaluate(
  rows: Array<{ h: number; a: number; w: number; hi: number; ai: number }>,
  attack: Float64Array,
  defense: Float64Array,
  gamma: number,
  rho: number,
  ridge: number,
): { ll: number; obj: number; gAttack: Float64Array; gDefense: Float64Array; gGamma: number; gRho: number } {
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
  let obj = ll;
  if (ridge > 0) {
    let meanA = 0;
    let meanD = 0;
    for (let i = 0; i < T; i++) {
      meanA += attack[i];
      meanD += defense[i];
    }
    meanA /= T;
    meanD /= T;
    let penalty = 0;
    for (let i = 0; i < T; i++) {
      const da = attack[i] - meanA;
      const dd = defense[i] - meanD;
      penalty += da * da + dd * dd;
      gAttack[i] -= 2 * ridge * da;
      gDefense[i] -= 2 * ridge * dd;
    }
    obj = ll - ridge * penalty;
  }
  return { ll, obj, gAttack, gDefense, gGamma, gRho };
}

/**
 * 最尤推定。試合が 1 件も無い・チームが 2 未満なら例外（黙って既定値を返さない）。
 */
export function fitDixonColes(matches: ReadonlyArray<MatchRecord>, opts: FitOptions = {}): FitResult {
  const xi = opts.xi ?? 0.0065;
  const fitRho = opts.fitRho ?? true;
  const ridge = opts.ridge ?? 0;
  if (!(ridge >= 0) || !Number.isFinite(ridge)) throw new Error(`ridge は 0 以上の有限値: ${opts.ridge}`);
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
  let cur = evaluate(rows, attack, defense, gamma, rho, ridge);
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
    // 採否は**罰則つきの目的関数**で判定する。生の尤度で判定すると、罰則を悪化させる
    // 歩みを受け入れてしまい、縮小が効かない
    const next = evaluate(rows, nAttack, nDefense, nGamma, nRho, ridge);
    if (next.obj >= cur.obj) {
      const gain = (next.obj - cur.obj) / weightSum;
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
    ridge,
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
  /** λ または μ が clampLambda の範囲外で丸められたか。true は適合側の異常の兆候 */
  clamped: boolean;
}

/**
 * 学習済みモデルで 1 試合を予測する。未知のチームは例外（中立値で埋めない）。
 *
 * `clampLambda` は期待得点の安全域。既定は無効（従来どおり）。**これは保険であって
 * 主役ではない** — 発動するのは適合側が壊れているときなので、`clamped` を見て
 * 原因（正則化の不足）を直すこと。丸めて誤魔化さない。
 */
export function predictMatch(
  fit: FitResult,
  home: string,
  away: string,
  opts: { maxGoals?: number; scorelines?: number; clampLambda?: readonly [number, number] } = {},
): MatchPrediction {
  if (!(home in fit.attack)) throw new Error(`未知のチーム: ${home}`);
  if (!(away in fit.attack)) throw new Error(`未知のチーム: ${away}`);
  const rawLambda = Math.exp(fit.attack[home] + fit.defense[away] + fit.homeAdvantage);
  const rawMu = Math.exp(fit.attack[away] + fit.defense[home]);
  let lambda = rawLambda;
  let mu = rawMu;
  if (opts.clampLambda) {
    const [lo, hi] = opts.clampLambda;
    if (!(lo > 0) || !(hi > lo)) throw new Error(`clampLambda が不正: [${lo}, ${hi}]`);
    lambda = Math.min(hi, Math.max(lo, lambda));
    mu = Math.min(hi, Math.max(lo, mu));
  }
  const clamped = lambda !== rawLambda || mu !== rawMu;
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
    clamped,
  };
}

/**
 * 枠内シュート層つきの当てはめ（2026-09-22・`dc-v5-shots`）。
 *
 * **xG ではない。** 1 本ごとの質は分からないので、使っているのは「枠内シュートの本数」
 * だけ。規約上自由に使える唯一の経路が football-data.co.uk の `HST` / `AST` 列で、
 * 追加の取得元も鍵も要らない（実測: 全リーグ・全季で欠測 0）。
 *
 * やり方: 同じ Dixon-Coles を**枠内シュートの本数**にも当てはめ（低スコア補正 ρ は
 * 枠内シュートには意味が無いので切る）、得られた λ を学習窓内の決定率
 * （得点合計 / 枠内シュート合計）で得点尺度へ直し、得点由来の λ と `(1−θ):θ` で混ぜる。
 * **決定率は学習窓の中だけ**から計算する（未来の試合を混ぜない）。
 *
 * 実測（probe の 4 季・9 リーグ・6,416 試合のウォークフォワード）:
 *
 * | θ | 選定期間 RPS | 検証期間 RPS | 検証の差 | t |
 * |---|---|---|---|---|
 * | 0（従来） | 0.2007 | 0.2004 | — | — |
 * | 0.15 | 0.1999 | 0.1999 | −0.00048 | −3.62 |
 * | **0.25** | 0.1995 | **0.1997** | **−0.00070** | **−3.16** |
 * | 0.35 | 0.1992 | 0.1996 | −0.00084 | −2.69 |
 * | 0.55 | 0.1989 | 0.1996 | −0.00086 | −1.75 |
 *
 * 選定期間だけなら θ=0.55 が最良だが、それはグリッドの端で検証期間では有意でない
 * （過学習の典型）。**検証済みの平坦域の中央として 0.25 を採る。**
 *
 * **既知の限界**: これでも市場には勝てない。同じ 6,416 試合で市場は 0.1946 で、
 * 対数オッズで結合しても**モデルを足した効果は −0.00003**（モデルの係数は −0.1 と負）。
 * 枠内シュート層はモデル単独の質を上げるだけで、**市場を超えるエッジにはならない。**
 */
export interface ShotLayer {
  /** 枠内シュートに当てはめた結果。学習データが足りなければ null */
  fit: FitResult | null;
  /** 学習窓内の決定率（得点合計 / 枠内シュート合計） */
  conversion: number;
  /** 混ぜる重み θ */
  weight: number;
}

/** 学習データから枠内シュート層を作る。使えなければ `fit: null`（推測で埋めない） */
export function fitShotLayer(train: readonly MatchRecord[], weight: number, opts: FitOptions, minMatches: number): ShotLayer {
  if (weight <= 0) return { fit: null, conversion: 0, weight: 0 };
  const withSot = train.filter((m) => typeof m.homeSot === "number" && typeof m.awaySot === "number");
  const sot = withSot.reduce((a, m) => a + (m.homeSot as number) + (m.awaySot as number), 0);
  const goals = withSot.reduce((a, m) => a + m.homeGoals + m.awayGoals, 0);
  if (withSot.length < minMatches || sot <= 0) return { fit: null, conversion: 0, weight };
  return {
    fit: fitDixonColes(
      withSot.map((m) => ({ ...m, homeGoals: m.homeSot as number, awayGoals: m.awaySot as number })),
      { ...opts, fitRho: false },
    ),
    conversion: goals / sot,
    weight,
  };
}

/**
 * 得点由来の当てはめと枠内シュート層を混ぜて確率を出す。
 * 層が無い・どちらかのチームが層に無い場合は、得点由来のまま返す（フェイルクローズ）。
 */
export function predictWithShots(fit: FitResult, layer: ShotLayer, home: string, away: string): {
  outcome: OutcomeProbabilities;
  lambda: number;
  mu: number;
  usedShots: boolean;
} {
  const g = predictMatch(fit, home, away);
  if (!layer.fit || !(home in layer.fit.attack) || !(away in layer.fit.attack) || layer.weight <= 0) {
    return { outcome: g.outcome, lambda: g.lambda, mu: g.mu, usedShots: false };
  }
  const s = predictMatch(layer.fit, home, away);
  const lambda = (1 - layer.weight) * g.lambda + layer.weight * s.lambda * layer.conversion;
  const mu = (1 - layer.weight) * g.mu + layer.weight * s.mu * layer.conversion;
  const matrix = scoreMatrix(lambda, mu, { maxGoals: 10, rho: fit.rho });
  return { outcome: outcomeProbabilities(matrix), lambda, mu, usedShots: true };
}
