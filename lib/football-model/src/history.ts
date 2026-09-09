/**
 * 結果の履歴（football/history/<Div>.ndjson・リポジトリに commit する）。
 *
 * 2026-09-06 から football-data.co.uk（www. ホスト）が Actions に 503 を返し、cache を
 * commit しない設計では学習データが丸ごと消えて予想が 1 件も出なかった（9/6〜9/9 実測）。
 * 「予想は試合前に必ず出す」（Founder 指示 2026-09-09）ためには、学習データが取得元の
 * 生死から独立していなければならない。そこで結果を **リポジトリ内の履歴**として持ち、
 * 毎日の取得は履歴への**差分の追記・更新**にする。取得元が全滅した日も、前日までの履歴で
 * 予想は出る（その予想は `historyAsOf` / `historyMissing` で鮮度を台帳に残す）。
 *
 * 取得元は 3 つ。優先度（同じ試合で得点が食い違ったときに勝つ側）:
 *   3 football-data.co.uk（一次情報・現地日付・B365 オッズ）
 *   2 mirror:xgabora（GitHub 上の写し。football-data.co.uk 由来で名前も同じ。更新は不定期）
 *   1 the-odds-api:scores（結果の速報。日付は UTC のキックオフ。オッズ無し）
 * 台帳（ledger/results.ndjson）は従来どおり追記専用。ここは「現在の最良の知識」を
 * 表す表で、行の置換はあるが、置換は優先度が同じか高い取得元からしか起きない。
 */
import type { MatchWithOdds } from "./footballData.ts";
import { loadMatches, parseCsv } from "./footballData.ts";
import { parseFootballDataRaw } from "./footballDataRaw.ts";
import type { LedgerMatch, LedgerResult } from "./ledger.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_FOOTBALL_DATA = "football-data.co.uk";
export const SOURCE_MIRROR = "mirror:xgabora";
export const SOURCE_ODDS_SCORES = "the-odds-api:scores";

const PRIORITY: Record<string, number> = {
  [SOURCE_FOOTBALL_DATA]: 3,
  [SOURCE_MIRROR]: 2,
  [SOURCE_ODDS_SCORES]: 1,
};

export function sourcePriority(source: string): number {
  return PRIORITY[source] ?? 0;
}

export interface HistoryRow {
  division: string;
  /** YYYY-MM-DD（取得元の日付。football-data は現地、Odds API は UTC） */
  date: string;
  /** HH:MM（あれば） */
  time: string | null;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  odds: { home: number; draw: number; away: number } | null;
  source: string;
  /** この行を取得元から取り込んだ時刻（ISO） */
  observedAt: string;
}

export interface MergeStats {
  added: number;
  replaced: number;
  /** 得点が食い違った件数（置換の有無に関わらず数える。ログに出して人が見る） */
  conflicts: number;
  kept: number;
}

const DAY_MS = 86_400_000;

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function key(r: { division: string; home: string; away: string }): string {
  return `${r.division}|${r.home}|${r.away}`;
}

/** 同じ対戦（division・home・away）で日付が ±1 日以内なら同じ試合とみなす（時差で現地日付がずれうる） */
export function sameMatch(a: { date: string }, b: { date: string }): boolean {
  return Math.abs(dayMs(a.date) - dayMs(b.date)) <= DAY_MS;
}

export function sortHistory(rows: HistoryRow[]): HistoryRow[] {
  return [...rows].sort((x, y) => x.date.localeCompare(y.date) || x.division.localeCompare(y.division) || x.home.localeCompare(y.home) || x.away.localeCompare(y.away));
}

/**
 * 履歴へ取り込む。
 *  - 未知の試合は追加
 *  - 既知で得点が同じ: 取得元の優先度が高ければ置換（現地日付・オッズを得る）、そうでなければ据え置き
 *  - 既知で得点が違う: 優先度が同じか高ければ置換、低ければ据え置き。いずれも conflicts に数える
 * 出力は日付順に整列（差分を小さく保つため）。
 */
export function mergeHistory(existing: HistoryRow[], incoming: HistoryRow[]): { rows: HistoryRow[]; stats: MergeStats } {
  const rows = [...existing];
  const index = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = key(r);
    const list = index.get(k);
    if (list) list.push(i);
    else index.set(k, [i]);
  });
  const stats: MergeStats = { added: 0, replaced: 0, conflicts: 0, kept: 0 };
  for (const inc of incoming) {
    const k = key(inc);
    const list = index.get(k) ?? [];
    const hit = list.find((i) => sameMatch(rows[i], inc));
    if (hit === undefined) {
      rows.push(inc);
      list.push(rows.length - 1);
      index.set(k, list);
      stats.added++;
      continue;
    }
    const cur = rows[hit];
    const sameScore = cur.homeGoals === inc.homeGoals && cur.awayGoals === inc.awayGoals;
    if (!sameScore) stats.conflicts++;
    const pIn = sourcePriority(inc.source);
    const pCur = sourcePriority(cur.source);
    const replace = sameScore ? pIn > pCur : pIn >= pCur;
    if (replace) {
      rows[hit] = inc;
      stats.replaced++;
    } else {
      stats.kept++;
    }
  }
  return { rows: sortHistory(rows), stats };
}

export function toMatchWithOdds(r: HistoryRow): MatchWithOdds & { source: string } {
  return {
    division: r.division,
    date: `${r.date}T${r.time ?? "00:00"}:00Z`,
    home: r.home,
    away: r.away,
    homeGoals: r.homeGoals,
    awayGoals: r.awayGoals,
    odds: r.odds,
    source: r.source,
  };
}

function fromMatch(m: MatchWithOdds, source: string, observedAt: string): HistoryRow {
  const time = m.date.slice(11, 16);
  return {
    division: m.division,
    date: m.date.slice(0, 10),
    time: time === "00:00" ? null : time,
    home: m.home,
    away: m.away,
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
    odds: m.odds,
    source,
    observedAt,
  };
}

/** football-data.co.uk の生 CSV（mmz4281/<季>/<Div>.csv・new/JPN.csv） */
export function historyFromFootballData(text: string, divisions: string[], observedAt: string): HistoryRow[] {
  return parseFootballDataRaw(text, { divisions }).matches.map((m) => fromMatch(m, SOURCE_FOOTBALL_DATA, observedAt));
}

/** GitHub の写し（xgabora/Club-Football-Match-Data の Matches.csv。football-data.co.uk と同じ名前） */
export function historyFromMirror(text: string, divisions: string[], observedAt: string, since?: string): HistoryRow[] {
  const rows = loadMatches(parseCsv(text), { divisions });
  return rows.filter((m) => !since || m.date.slice(0, 10) >= since).map((m) => fromMatch(m, SOURCE_MIRROR, observedAt));
}

/** 台帳の results.ndjson（football-data.co.uk 由来・直近 30 日ぶんが追記されている）。初期化と再構築に使う */
export function historyFromLedgerResults(results: LedgerResult[]): HistoryRow[] {
  return results.map((r) => ({
    division: r.league,
    date: r.date,
    time: null,
    home: r.home,
    away: r.away,
    homeGoals: r.homeGoals,
    awayGoals: r.awayGoals,
    odds: null,
    source: r.source,
    observedAt: r.recordedAt,
  }));
}

/** The Odds API /v4/sports/<sport>/scores の 1 要素 */
export interface OddsScoreEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: Array<{ name: string; score: string }> | null;
  last_update: string | null;
}

/**
 * Odds API の結果 → 履歴行。completed のものだけ。名前は football-data の表記へ解決し、
 * 解決できない試合は捨てる（推測で埋めない）。日付は commence_time の UTC 日付
 * （現地日付とは ±1 日ずれうる。mergeHistory / settle は ±1 日を同じ試合とみなす）。
 */
export function historyFromOddsScores(
  events: OddsScoreEvent[],
  division: string,
  resolve: (name: string) => string | null,
  observedAt: string,
  /** 台帳の日程（providerId = Odds API の id）。あれば名前は台帳の解決済みの値を使う */
  registry?: Map<string, LedgerMatch>,
): { rows: HistoryRow[]; unresolved: number; incomplete: number } {
  const rows: HistoryRow[] = [];
  let unresolved = 0;
  let incomplete = 0;
  for (const e of events) {
    const reg = registry?.get(e.id);
    if (reg && reg.league !== division) continue;
    if (!e.completed || !e.scores) {
      incomplete++;
      continue;
    }
    const hs = e.scores.find((s) => s.name === e.home_team)?.score;
    const as = e.scores.find((s) => s.name === e.away_team)?.score;
    const h = hs === undefined ? NaN : Number(hs);
    const a = as === undefined ? NaN : Number(as);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) {
      incomplete++;
      continue;
    }
    const home = reg?.home ?? resolve(e.home_team);
    const away = reg?.away ?? resolve(e.away_team);
    if (!home || !away) {
      unresolved++;
      continue;
    }
    rows.push({
      division,
      date: e.commence_time.slice(0, 10),
      time: e.commence_time.slice(11, 16),
      home,
      away,
      homeGoals: h,
      awayGoals: a,
      odds: null,
      source: SOURCE_ODDS_SCORES,
      observedAt,
    });
  }
  return { rows, unresolved, incomplete };
}

/**
 * 鮮度の物差し: 台帳が知っている「開始から graceHours 以上経った試合」のうち、
 * 履歴に結果が無いものの数。0 なら履歴は台帳の知る範囲で最新。多いほど取得元が
 * 止まっている（冬季中断や国際試合週間の「試合が無い」とは区別できる）。
 */
export function countMissingResults(matches: Iterable<LedgerMatch>, history: HistoryRow[], nowIso: string, graceHours = 6): number {
  const now = Date.parse(nowIso);
  const byKey = new Map<string, HistoryRow[]>();
  for (const r of history) {
    const k = key(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  let missing = 0;
  for (const m of matches) {
    if (Date.parse(m.kickoffAt) > now - graceHours * 3_600_000) continue;
    const list = byKey.get(`${m.league}|${m.home}|${m.away}`) ?? [];
    const probe = { date: m.kickoffAt.slice(0, 10) };
    if (!list.some((r) => sameMatch(r, probe))) missing++;
  }
  return missing;
}

export function historyPath(dir: string, division: string): string {
  return join(dir, `${division}.ndjson`);
}

export function readHistory(dir: string, division: string): HistoryRow[] {
  const p = historyPath(dir, division);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryRow);
}

/** 整列して書く（既存と同じ内容なら書かない＝git 差分を作らない） */
export function writeHistory(dir: string, division: string, rows: HistoryRow[]): boolean {
  mkdirSync(dir, { recursive: true });
  const p = historyPath(dir, division);
  const text = sortHistory(rows)
    .map((r) => JSON.stringify(r))
    .join("\n") + (rows.length ? "\n" : "");
  if (existsSync(p) && readFileSync(p, "utf8") === text) return false;
  writeFileSync(p, text);
  return true;
}
