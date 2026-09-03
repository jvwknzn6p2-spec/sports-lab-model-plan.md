/**
 * football-data.co.uk の生 CSV（本家の書式）を MatchWithOdds へ写す。
 *
 * 2 種類の書式を扱う（probe/football のサンプルが fixture）:
 *   主要リーグ（mmz4281/<季>/<Div>.csv・fixtures.csv）:
 *     Div, Date(dd/mm/yyyy), Time, HomeTeam, AwayTeam, FTHG, FTAG, FTR, …, B365H/D/A, AvgH/D/A, HxG/AxG
 *   追加リーグ（new/JPN.csv 等）:
 *     Country, League, Season, Date(dd/mm/yyyy), Time, Home, Away, HG, AG, Res, …, AvgCH/CD/CA（クロージング平均）
 * fixtures.csv は得点が空（未消化）なので、得点が無い行は「日程」として別に返す。
 *
 * 時刻は英国の現地時刻（BST/GMT）または日本時刻（JPN）で、CSV には時差の情報が無い。
 * ここでは UTC として扱わず、`dateLocal` / `timeLocal` を保持したまま、
 * 学習・決済の順序づけには日付だけを使う（キックオフの正確な時刻は The Odds API 側が権威）。
 */
import type { MatchWithOdds } from "./footballData.ts";
import { parseCsv } from "./footballData.ts";

export interface Fixture {
  division: string;
  dateLocal: string; // YYYY-MM-DD
  timeLocal: string | null; // HH:MM
  home: string;
  away: string;
  odds: { home: number; draw: number; away: number } | null;
}

export interface RawParseResult {
  matches: MatchWithOdds[];
  fixtures: Fixture[];
  /** 得点は無いが日付も読めない等、捨てた行の数 */
  dropped: number;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** dd/mm/yyyy または dd/mm/yy → YYYY-MM-DD */
export function parseUkDate(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const mm = String(Number(m[2])).padStart(2, "0");
  const dd = String(Number(m[1])).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/** 列名の揺れ（主要 / 追加リーグ）を吸収する */
function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k] ?? row[`﻿${k}`];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function oddsOf(row: Record<string, string>): Fixture["odds"] {
  // 主要リーグ: B365（試合前）→ 平均。追加リーグ: クロージングの B365 → Pinnacle → 平均
  const trip = (h?: string, d?: string, a?: string) => {
    const H = num(h);
    const D = num(d);
    const A = num(a);
    return H && D && A && H > 1 && D > 1 && A > 1 ? { home: H, draw: D, away: A } : null;
  };
  return (
    trip(pick(row, "B365H"), pick(row, "B365D"), pick(row, "B365A")) ??
    trip(pick(row, "AvgH"), pick(row, "AvgD"), pick(row, "AvgA")) ??
    trip(pick(row, "B365CH"), pick(row, "B365CD"), pick(row, "B365CA")) ??
    trip(pick(row, "PSCH"), pick(row, "PSCD"), pick(row, "PSCA")) ??
    trip(pick(row, "AvgCH"), pick(row, "AvgCD"), pick(row, "AvgCA")) ??
    trip(pick(row, "PH"), pick(row, "PD"), pick(row, "PA"))
  );
}

/** 追加リーグの Division コード。League 名から決める（JPN.csv は " J1 League"） */
function divisionOf(row: Record<string, string>): string {
  const div = pick(row, "Div");
  if (div) return div.trim();
  const league = (pick(row, "League") ?? "").trim();
  const country = (pick(row, "Country") ?? "").trim();
  if (country === "Japan" && /J1/.test(league)) return "JAP";
  if (country === "Japan" && /J2/.test(league)) return "JAP2";
  return `${country}:${league}`;
}

export function parseFootballDataRaw(text: string, opts: { divisions?: string[] } = {}): RawParseResult {
  const keep = opts.divisions ? new Set(opts.divisions) : null;
  const out: RawParseResult = { matches: [], fixtures: [], dropped: 0 };
  for (const row of parseCsv(text.replace(/^﻿/, ""))) {
    const division = divisionOf(row);
    if (keep && !keep.has(division)) continue;
    const date = parseUkDate(pick(row, "Date") ?? "");
    const home = (pick(row, "HomeTeam", "Home") ?? "").trim();
    const away = (pick(row, "AwayTeam", "Away") ?? "").trim();
    if (!date || !home || !away) {
      out.dropped++;
      continue;
    }
    const timeRaw = pick(row, "Time");
    const timeLocal = timeRaw && /^\d{1,2}:\d{2}$/.test(timeRaw.trim()) ? timeRaw.trim().padStart(5, "0") : null;
    const odds = oddsOf(row);
    const h = num(pick(row, "FTHG", "HG"));
    const a = num(pick(row, "FTAG", "AG"));
    if (h === null || a === null) {
      out.fixtures.push({ division, dateLocal: date, timeLocal, home, away, odds });
      continue;
    }
    out.matches.push({
      division,
      date: `${date}T${timeLocal ?? "00:00"}:00Z`,
      home,
      away,
      homeGoals: Math.round(h),
      awayGoals: Math.round(a),
      odds,
    });
  }
  return out;
}
