/**
 * サッカーのハンデ清算表 SOCCER_LADDER_V1 / spec 1.0.0 FROZEN
 *
 * 出典は Founder 提供の「サッカーハンデ早見表」（2026-09-15 受領）。
 * share は**ハンデを出している側（GIVING）**から見た取り分係数 ∈ [-1, +1]。
 * m = 出し側チームの得点差（負け = 負値）。表の見出しどおり「出しているチームから見て」。
 *
 * ## 野球（CUSTOM_TABLE_V1）とは別物である
 *
 * Founder の明示（2026-09-15）「野球とサッカーのハンデ計算式は全く別物。野球の応用が
 * サッカー」。実装を 1 行ずつ突き合わせた結果、決定的な差は **0 台の刻み**にあった:
 *
 * | 表記 | 野球 `0.3` | サッカー `0/3` |
 * |---|---|---|
 * | 引き分け（m=0） | 30% 負け | 30% 負け（同じ） |
 * | 1 点差勝ち（m=1） | **70% 勝ち** | **100% 勝ち** |
 *
 * 野球の `0.d` は m=0 と m=1 の 2 つの得点差に跨がる。サッカーの `0/d` は引き分けだけに
 * 効く。得点差が広く散る野球と、0〜2 に集中し引き分けが 25% あるサッカーの違いで、
 * **野球の表を流用してはならない**。`0半` `2.x` `2半` も野球の定義域には無い。
 *
 * ## 構造: 一本の梯子
 *
 * 表全体は「常にただ 1 つの得点差だけが中間の係数を持ち、その上下は丸勝ち・丸負け」
 * という梯子になっている。刻みは 1/10。
 *
 *   0/0 → 0/1…0/9 → 0半 → 0半1…0半9 → 1 → 1.1…1.9 → 1半 → 1半1…1半9 → 2 → …
 *
 * - **A 型**（整数 k から k半 へ向かう `k` `k.d` `0/d`）: 係数を持つのは m=k。
 *   値は −d/10（d=0 なら勝負無し）。m<k は丸負け、m>k は丸勝ち。
 * - **B 型**（k半 から k+1 へ向かう `k半` `k半d`）: 係数を持つのは m=k+1。
 *   値は +(10−d)/10（d=0 なら丸勝ち）。m<k+1 は丸負け、m>k+1 は丸勝ち。
 *
 * 「1半」は 1.5 ではない。正規化は絶対禁止。
 *
 * ## この表は賭けの推奨ではない
 *
 * ここにあるのは決済（結果が出た後の取り分）の規則だけで、EV も推奨も含まない。
 * EV 層はモデルが市場に並ぶまで着手しない（football/README.md の「既知の限界」）。
 */

export const HANDICAP_RULES_VERSION = "SOCCER_LADDER_V1" as const;
export const HANDICAP_SPEC_VERSION = "1.0.0" as const;

export type HandicapSide = "GIVING" | "RECEIVING";

export interface ParsedHandicap {
  /** 貼られた表記そのまま（正規化しない） */
  raw: string;
  /** 梯子の基準となる整数部 k */
  base: number;
  /** A 型 = false（k → k半）、B 型 = true（k半 → k+1） */
  half: boolean;
  /** 1/10 の刻み 0〜9 */
  sub: number;
}

export class HandicapNotationError extends Error {
  constructor(notation: string) {
    super(`未定義のハンデ表記です: ${notation}`);
    this.name = "HandicapNotationError";
  }
}

/**
 * Founder の早見表に実際に載っていた表記。ここに無い表記も梯子の規則で決まるが、
 * **表で直接確認したのはこの集合だけ**なので、厳密に運用したい呼び出し側はこれで絞る。
 */
export const VERIFIED_NOTATIONS: readonly string[] = [
  "0/0", "0/1", "0/2", "0/3", "0/4", "0/5", "0/6", "0/7", "0/8", "0/9",
  "0半", "0半3", "0半5", "0半7",
  "1", "1.3", "1.5", "1.7",
  "1半", "1半3", "1半5", "1半7",
  "2", "2.3", "2.5", "2.7",
  "2半",
];

/**
 * 表記を解析する。定義域外は例外（推測で埋めない）。
 *
 * 受理する形:
 *   `k`        整数（`0` は `0/0` と同義）
 *   `k.d`      整数 k と k半 の間（`0.d` は `0/d` と同義）
 *   `0/d`      早見表の 0 台の書き方
 *   `k半`      半
 *   `k半d`     半と次の整数の間
 */
export function parseHandicap(notation: string): ParsedHandicap {
  const raw = notation.trim();

  // 0 台の早見表記 "0/0"〜"0/9"
  const zero = /^0\/([0-9])$/.exec(raw);
  if (zero) return { raw, base: 0, half: false, sub: Number(zero[1]) };

  // 整数 "0" "1" "2" …（末尾 .0 も同義）
  const int = /^(\d+)(?:\.0)?$/.exec(raw);
  if (int) return { raw, base: Number(int[1]), half: false, sub: 0 };

  // "k.d"（k と k半 の間）
  const dec = /^(\d+)\.([1-9])$/.exec(raw);
  if (dec) return { raw, base: Number(dec[1]), half: false, sub: Number(dec[2]) };

  // "k半"
  const half = /^(\d+)半$/.exec(raw);
  if (half) return { raw, base: Number(half[1]), half: true, sub: 0 };

  // "k半d"（k半 と k+1 の間）
  const halfSub = /^(\d+)半([1-9])$/.exec(raw);
  if (halfSub) return { raw, base: Number(halfSub[1]), half: true, sub: Number(halfSub[2]) };

  throw new HandicapNotationError(raw);
}

/** 表記が解析できるか */
export function isValidHandicapNotation(notation: string): boolean {
  try {
    parseHandicap(notation);
    return true;
  } catch {
    return false;
  }
}

/** 早見表で直接確認した表記か */
export function isVerifiedNotation(notation: string): boolean {
  return VERIFIED_NOTATIONS.includes(notation.trim());
}

/**
 * GIVING 側の取り分を 1/10 単位の整数（−10〜+10）で返す。
 * 浮動小数の誤差を避けるため整数で持ち、割るのは最後だけにする。
 *
 * @param m 出し側チームの得点差（勝ち = 正、引き分け = 0、負け = 負）
 */
export function shareTenthsGiving(notation: string, m: number): number {
  if (!Number.isInteger(m)) throw new Error(`得点差は整数: ${m}`);
  const { base, half, sub } = parseHandicap(notation);

  if (half) {
    // B 型: 係数を持つのは m = base+1（+(10−sub)/10）。その下は丸負け、上は丸勝ち
    const pivot = base + 1;
    if (m < pivot) return -10;
    if (m === pivot) return 10 - sub;
    return 10;
  }
  // A 型: 係数を持つのは m = base（−sub/10）。その下は丸負け、上は丸勝ち
  if (m < base) return -10;
  // sub=0（勝負無し）で -0 を返さない。-0 は Object.is で 0 と区別され、
  // 突き合わせや集計で静かに食い違う
  if (m === base) return sub === 0 ? 0 : -sub;
  return 10;
}

/** GIVING 側の取り分 ∈ [−1, +1] */
export function shareGiving(notation: string, m: number): number {
  return shareTenthsGiving(notation, m) / 10;
}

/** RECEIVING 側は完全な鏡像（勝負無しで -0 を返さない） */
export function shareReceiving(notation: string, m: number): number {
  const t = shareTenthsGiving(notation, m);
  return t === 0 ? 0 : -t / 10;
}

/** 指定サイドの取り分 */
export function share(notation: string, m: number, side: HandicapSide): number {
  return side === "GIVING" ? shareGiving(notation, m) : shareReceiving(notation, m);
}

/**
 * 表の同一性を示す指紋。全ての確認済み表記 × 得点差 −3〜+5 を正準化して並べたもの。
 * **表を 1 マスでも変えるとこの値が変わる**ので、テストで固定して凍結の担保にする。
 */
export function tableFingerprintSource(): string {
  const lines: string[] = [`${HANDICAP_RULES_VERSION}/${HANDICAP_SPEC_VERSION}`];
  for (const n of VERIFIED_NOTATIONS) {
    const cells: string[] = [];
    for (let m = -3; m <= 5; m++) cells.push(String(shareTenthsGiving(n, m)));
    lines.push(`${n}:${cells.join(",")}`);
  }
  return lines.join("\n");
}
