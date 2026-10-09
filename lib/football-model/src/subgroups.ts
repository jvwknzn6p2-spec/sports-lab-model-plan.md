/**
 * 「市場が特定のチーム（や条件）に限って系統的に外していないか」を測る（2026-10-09・Founder 指示）。
 *
 * 単位は「チーム × 試合」。1 試合からホーム側・アウェイ側の 2 行を作り、
 *   y = そのチームが勝ったか（0/1）、p = 市場がつけたそのチームの勝率（控除を除いた値）
 * の差 y − p（残差）を集計する。市場がそのチームを正しく値付けしていれば、残差の和は 0 の周りに
 * 偶然の幅 √Σp(1−p) で散らばる。z = Σ(y−p) / √Σp(1−p)。
 *
 * **検証の規則（結果を見る前に固定）**
 *  - 前半で探し、後半で確かめる。前半だけで「外れている」と言えるチームは、100 チームを見れば
 *    偶然でも 5 チーム程度出る（|z|≥2 は 4.6%）。後半でも同じ向きに外れ続けて初めて「実在」
 *  - 市場全体の本命・大穴の偏り（A で実測済み）は、前半だけで当てた γ 補正で先に取り除く。
 *    取り除かないと「強いチーム＝本命が多い」だけで、チームの性質に見えてしまう
 *  - 判定は 3 つ: ①前半と後半の z の相関（順位の持続）②偶然の幅を超えるばらつきの大きさ
 *    ③前半で選んだチームの後半の残差（選ぶ → 確かめる、を そのまま再現）
 */
import { adjust } from "./marketResiduals.ts";
import type { ProbabilityTriple } from "./scoring.ts";

export interface TeamGame {
  date: string;
  league: string;
  team: string;
  opponent: string;
  role: "H" | "A";
  /** 市場の勝率（補正後） */
  p: number;
  /** 補正前の 3 値（帯の分類用） */
  market: ProbabilityTriple;
  win: 0 | 1;
  /** そのチームの勝ちに付いていたオッズ（取得元の 1 社） */
  odds: number;
}

export interface Cell {
  n: number;
  /** Σ(y − p) */
  sumR: number;
  /** Σ p(1 − p)（偶然の分散） */
  v: number;
  /** Σy, Σp */
  wins: number;
  sumP: number;
}

export const emptyCell = (): Cell => ({ n: 0, sumR: 0, v: 0, wins: 0, sumP: 0 });

export function add(c: Cell, g: { p: number; win: 0 | 1 }): void {
  c.n++;
  c.sumR += g.win - g.p;
  c.v += g.p * (1 - g.p);
  c.wins += g.win;
  c.sumP += g.p;
}

export const zOf = (c: Cell): number => (c.v > 0 ? c.sumR / Math.sqrt(c.v) : 0);

export function group(games: TeamGame[], key: (g: TeamGame) => string | null): Map<string, Cell> {
  const m = new Map<string, Cell>();
  for (const g of games) {
    const k = key(g);
    if (k === null) continue;
    let c = m.get(k);
    if (!c) m.set(k, (c = emptyCell()));
    add(c, g);
  }
  return m;
}

/** 1 試合 → 2 行（ホーム・アウェイ）。γ は前半だけから当てた値を渡す */
export function teamGames(
  rows: Array<{ division: string; date: string; home: string; away: string; homeGoals: number; awayGoals: number; odds: { home: number; draw: number; away: number } | null }>,
  gamma: number,
): TeamGame[] {
  const out: TeamGame[] = [];
  for (const r of rows) {
    const o = r.odds;
    if (!o || !(o.home > 1 && o.draw > 1 && o.away > 1)) continue;
    const inv = [1 / o.home, 1 / o.draw, 1 / o.away];
    const s = inv[0]! + inv[1]! + inv[2]!;
    const market: ProbabilityTriple = [inv[0]! / s, inv[1]! / s, inv[2]! / s];
    const p = adjust(market, 0, { gamma, b: 0 });
    const res = r.homeGoals > r.awayGoals ? 0 : r.homeGoals === r.awayGoals ? 1 : 2;
    out.push({ date: r.date, league: r.division, team: r.home, opponent: r.away, role: "H", p: p[0], market, win: res === 0 ? 1 : 0, odds: o.home });
    out.push({ date: r.date, league: r.division, team: r.away, opponent: r.home, role: "A", p: p[2], market, win: res === 2 ? 1 : 0, odds: o.away });
  }
  return out;
}

/** 決定的な乱数（並べ替え検定を毎回同じ結果にする） */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

export interface Persistence {
  /** 両期間に minN 以上いるセルの数 */
  k: number;
  /** 前半の z と後半の z の相関 */
  r: number;
  /** 並べ替え検定の片側 p 値（後半のラベルを入れ替えて r 以上が出る割合） */
  pPerm: number;
}

export function persistence(early: Map<string, Cell>, late: Map<string, Cell>, minN: number, perms = 10000, seed = 20261009): Persistence {
  const keys = [...early.keys()].filter((k) => early.get(k)!.n >= minN && (late.get(k)?.n ?? 0) >= minN).sort();
  const x = keys.map((k) => zOf(early.get(k)!));
  const y = keys.map((k) => zOf(late.get(k)!));
  const r = pearson(x, y);
  if (!Number.isFinite(r)) return { k: keys.length, r: NaN, pPerm: NaN };
  const rand = rng(seed);
  let ge = 0;
  const yy = [...y];
  for (let i = 0; i < perms; i++) {
    for (let j = yy.length - 1; j > 0; j--) {
      const t = Math.floor(rand() * (j + 1));
      [yy[j], yy[t]] = [yy[t]!, yy[j]!];
    }
    if (pearson(x, yy) >= r) ge++;
  }
  return { k: keys.length, r, pPerm: (ge + 1) / (perms + 1) };
}

export interface Heterogeneity {
  k: number;
  /** Σz²（偶然だけなら自由度 k の χ² ≈ 平均 k・sd √(2k)） */
  chi2: number;
  /** (χ² − k) / √(2k)。2 を超えると偶然の幅を超えたばらつき */
  excessZ: number;
  /**
   * 偶然を除いた「本当の」チーム差の大きさ（勝率の pp）。積率法:
   * τ² = max(0, (Σ (r̄_i)² w_i − (k−1)) / (Σw_i − Σw_i²/Σw_i))、w_i = n_i² / v_i
   */
  tauPp: number;
}

export function heterogeneity(cells: Map<string, Cell>, minN: number): Heterogeneity {
  const cs = [...cells.values()].filter((c) => c.n >= minN && c.v > 0);
  const k = cs.length;
  const chi2 = cs.reduce((a, c) => a + zOf(c) ** 2, 0);
  // DerSimonian–Laird（効果 = セルの平均残差 r̄ = sumR/n、分散 = v/n²）
  const eff = cs.map((c) => c.sumR / c.n);
  const w = cs.map((c) => (c.n * c.n) / c.v);
  const sw = w.reduce((a, b) => a + b, 0);
  const mu = eff.reduce((a, e, i) => a + e * w[i]!, 0) / sw;
  const q = eff.reduce((a, e, i) => a + w[i]! * (e - mu) ** 2, 0);
  const denom = sw - w.reduce((a, b) => a + b * b, 0) / sw;
  const tau2 = Math.max(0, (q - (k - 1)) / denom);
  return { k, chi2, excessZ: (chi2 - k) / Math.sqrt(2 * k), tauPp: Math.sqrt(tau2) * 100 };
}

export interface Selection {
  /** 前半で選ばれたセル数 */
  picked: number;
  /** 選ばれたセルの後半の残差を、前半の向きにそろえて合算した z（0 なら持続していない） */
  lateZ: number;
  /** 後半の試合数 */
  lateN: number;
  /** 後半の勝率の差（実際 − 市場, pp・前半の向きにそろえて） */
  lateDiffPp: number;
  /** 前半の残差（同じ向き・pp）— 後半と比べて「どれだけ縮んだか」を見る */
  earlyDiffPp: number;
}

/** 前半で |z| ≥ zMin のセルを選び、後半で同じ向きに外れ続けるかを見る */
export function selection(early: Map<string, Cell>, late: Map<string, Cell>, zMin: number, minN: number): Selection {
  let sumR = 0;
  let v = 0;
  let n = 0;
  let eR = 0;
  let eN = 0;
  let picked = 0;
  for (const [k, e] of early) {
    if (e.n < minN) continue;
    const ze = zOf(e);
    if (Math.abs(ze) < zMin) continue;
    const l = late.get(k);
    if (!l || l.n === 0) continue;
    const sgn = Math.sign(ze);
    picked++;
    sumR += sgn * l.sumR;
    v += l.v;
    n += l.n;
    eR += sgn * e.sumR;
    eN += e.n;
  }
  return { picked, lateZ: v > 0 ? sumR / Math.sqrt(v) : 0, lateN: n, lateDiffPp: n ? (sumR / n) * 100 : 0, earlyDiffPp: eN ? (eR / eN) * 100 : 0 };
}

/** Wilson 95% 区間 */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.959964;
  const ph = k / n;
  const d = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

/** 欧州の季節（7/1 区切り）。JAP は暦年なので年で切る */
export function seasonOf(g: { league: string; date: string }): string {
  const y = Number(g.date.slice(0, 4));
  const m = Number(g.date.slice(5, 7));
  if (g.league === "JAP") return String(y);
  return m >= 7 ? `${y}-${(y + 1) % 100}` : `${y - 1}-${y % 100}`;
}
