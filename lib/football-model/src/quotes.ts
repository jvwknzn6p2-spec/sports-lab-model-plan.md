/**
 * 貼られた日本式ハンデの記録と答え合わせ（Founder 承認 2026-10-27「①から」）。
 *
 * 目的は勝率を当てることではなく、**日本式ハンデの値付けと海外市場（アジアンハンデ）のずれ**を測ること。
 * - 記録: 貼り付け 1 カード = 1 行を `football/quotes/quotes.ndjson` へ追記する（追記専用・同じ id は二重に書かない）
 * - 評価: 試合前の最後のアジアンハンデと 2.5 点の上下（`football/lines/football-data/`）から得点差の分布を当て、
 *   貼られたハンデの両側の期待値（勝ち 0.9 倍）を出す。決着していれば実際の損益も並べる
 *
 * 1X2（勝ち・引き分け・負け）の確率から得点差の分布を作る近似は使わない。2026-10-27 に過去の貼り付け 27 件で
 * 測ったところ、アジアンハンデと同じ基準（1半 = −1.5）の試合で貰い側へ 1.5〜5pt 偏っていた（Inter v Fiorentina・
 * Stuttgart v M'gladbach）。アジアンハンデが無い試合は**評価しない**（推測で埋めない）。
 *
 * 得点はホーム・アウェイが独立のポアソンという近似で、引き分けを少なめに出す癖がある。0/x 系（引き分けの扱いが
 * 決済を決める表記）では特に効くので、結果は件数とともに読むこと。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { shareGiving } from "./handicap.ts";

export interface QuoteRow {
  /** 貼り付け時刻・試合・出し側・ハンデから作る（同じ貼り付けを二重に記録しない） */
  id: string;
  /** Founder が貼った時刻（ISO） */
  pastedAt: string;
  recordedAt: string;
  /** 会話の記録から後で起こした行（2026-10-27 の初回分） */
  backfilled?: boolean;
  /** 元のカードのテキスト（そのまま） */
  source: string;
  league: string;
  providerId: string;
  home: string;
  away: string;
  kickoffAt: string;
  givingHome: boolean;
  handicap: string;
  /** 同じ行に並んでいた 2 つ目以降のハンデ（意味は貼り付けからは分からない） */
  alternatives: string[];
}

export function quoteId(pastedAt: string, providerId: string, givingHome: boolean, handicap: string): string {
  return createHash("sha256").update(`${pastedAt}|${providerId}|${givingHome ? "H" : "A"}|${handicap}`).digest("hex").slice(0, 16);
}

export function readQuotes(path: string): QuoteRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as QuoteRow);
}

/** 勝ち 0.9 倍（日本式の払い戻し）。取り分 s（−1〜1）を損益へ */
export const pnl = (s: number): number => (s > 0 ? s * 0.9 : s);

export interface AsianQuote {
  /** ホームのハンデ（−0.5 = ホームが 0.5 出す） */
  line: number;
  home: number;
  away: number;
}
export interface OuQuote {
  over: number;
  under: number;
}

/** アジアンハンデ（ホーム側）の結果を「勝ち 1 / 半勝ち 0.5 / 引き分け 0 / 半負け −0.5 / 負け −1」で返す。0.25 刻みは半分ずつ */
export function asianHomeResult(line: number, margin: number): number {
  const q = Math.round(line * 4);
  if (q % 2 !== 0) return (asianHomeResult((q - 1) / 4, margin) + asianHomeResult((q + 1) / 4, margin)) / 2;
  const x = margin + line;
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

const pois = (l: number, k: number): number => {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
};

/** 得点差（ホーム − アウェイ）→ 確率。総得点 3 以上の確率も返す */
export function marginDistribution(lh: number, la: number): { margin: Map<number, number>; over25: number } {
  const margin = new Map<number, number>();
  let over25 = 0;
  for (let i = 0; i <= 12; i++)
    for (let j = 0; j <= 12; j++) {
      const p = pois(lh, i) * pois(la, j);
      margin.set(i - j, (margin.get(i - j) ?? 0) + p);
      if (i + j >= 3) over25 += p;
    }
  return { margin, over25 };
}

/**
 * アジアンハンデと 2.5 の上下の価格（マージンを比で除いた公平値）に合うホーム・アウェイの得点期待値。
 * 2 本の式に 2 つの未知数なので、粗い格子 → 細かい格子で二乗誤差を最小にする
 */
export function fitFromAsian(ah: AsianQuote, ou: OuQuote): { lh: number; la: number; err: number } {
  const qh = 1 / ah.home / (1 / ah.home + 1 / ah.away);
  const fair = 1 / qh;
  const qo = 1 / ou.over / (1 / ou.over + 1 / ou.under);
  const loss = (lh: number, la: number): number => {
    const { margin, over25 } = marginDistribution(lh, la);
    let ev = 0;
    for (const [m, p] of margin) {
      const r = asianHomeResult(ah.line, m);
      ev += p * (r > 0 ? r * (fair - 1) : r);
    }
    return ev * ev + (over25 - qo) ** 2;
  };
  let best = { lh: 1.4, la: 1.1, err: Infinity };
  for (const step of [0.05, 0.01]) {
    const c = best.err === Infinity ? null : best;
    const range = c ? { a0: c.lh - 0.1, a1: c.lh + 0.1, b0: c.la - 0.1, b1: c.la + 0.1 } : { a0: 0.1, a1: 4.5, b0: 0.1, b1: 4.5 };
    for (let a = Math.max(0.05, range.a0); a <= range.a1 + 1e-9; a += step)
      for (let b = Math.max(0.05, range.b0); b <= range.b1 + 1e-9; b += step) {
        const e = loss(a, b);
        if (e < best.err) best = { lh: a, la: b, err: e };
      }
  }
  return best;
}

/** 貼られた日本式ハンデの両側の期待値（勝ち 0.9 倍）。margin はホーム − アウェイの分布 */
export function japaneseEv(margin: Map<number, number>, handicap: string, givingHome: boolean): { giving: number; receiving: number } {
  let giving = 0;
  let receiving = 0;
  for (const [m, p] of margin) {
    const s = shareGiving(handicap, givingHome ? m : -m);
    giving += p * pnl(s);
    receiving += p * pnl(-s);
  }
  return { giving, receiving };
}

export interface LineRow {
  providerId: string;
  kickoffAt: string;
  asian?: { line: number; avg: [number, number] | null } | null;
  ou25?: { avg: [number, number] | null } | null;
}

/**
 * providerId → キックオフ前に取った最後のアジアンハンデ・2.5 の上下（取得時刻つき）。
 * キックオフ前の写しが無い試合だけ、キックオフ後に最初に取った写しを `afterKickoff` 付きで返す。
 * fixtures.csv の価格は試合前に集めたもので試合中には動かない（football-data.co.uk の作り）が、
 * それを確かめる手段がこちらに無いので、**混ぜずに印を付けて別に数える**
 */
export function lastLinesBeforeKickoff(dir: string): Map<string, { fetchedAt: string; row: LineRow; afterKickoff?: true }> {
  const out = new Map<string, { fetchedAt: string; row: LineRow; afterKickoff?: true }>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json$/.exec(f);
    if (!m) continue;
    const fetchedAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    let rows: LineRow[];
    try {
      rows = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    for (const r of rows) {
      if (!r.providerId) continue;
      if (fetchedAt < r.kickoffAt) out.set(r.providerId, { fetchedAt, row: r });
      else if (!out.has(r.providerId)) out.set(r.providerId, { fetchedAt, row: r, afterKickoff: true });
    }
  }
  return out;
}

export interface QuoteEvaluation {
  quote: QuoteRow;
  /** 評価に使った市場（無ければ評価しない） */
  linesAt: string | null;
  /** 市場の写しをキックオフ後に取った（価格自体は試合前のもの） */
  linesAfterKickoff: boolean;
  asianLine: number | null;
  evGiving: number | null;
  evReceiving: number | null;
  score: string | null;
  /** 決着したときの出し側の取り分（−1〜1） */
  share: number | null;
}

export function evaluateQuote(
  q: QuoteRow,
  lines: Map<string, { fetchedAt: string; row: LineRow; afterKickoff?: true }>,
  result: { homeGoals: number; awayGoals: number } | null,
): QuoteEvaluation {
  const l = lines.get(q.providerId);
  let evGiving: number | null = null;
  let evReceiving: number | null = null;
  const ah = l?.row.asian;
  const ou = l?.row.ou25;
  if (ah?.avg && ou?.avg) {
    const fit = fitFromAsian({ line: ah.line, home: ah.avg[0], away: ah.avg[1] }, { over: ou.avg[0], under: ou.avg[1] });
    const ev = japaneseEv(marginDistribution(fit.lh, fit.la).margin, q.handicap, q.givingHome);
    evGiving = ev.giving;
    evReceiving = ev.receiving;
  }
  const share = result ? shareGiving(q.handicap, q.givingHome ? result.homeGoals - result.awayGoals : result.awayGoals - result.homeGoals) : null;
  return {
    quote: q,
    linesAt: evGiving === null ? null : l!.fetchedAt,
    linesAfterKickoff: evGiving !== null && l!.afterKickoff === true,
    asianLine: evGiving === null ? null : ah!.line,
    evGiving,
    evReceiving,
    score: result ? `${result.homeGoals}-${result.awayGoals}` : null,
    share,
  };
}
