/**
 * football-data.co.uk 由来の試合 CSV を MatchRecord へ写す。
 *
 * 対応する書式は xgabora/Club-Football-Match-Data-2000-2025 の Matches.csv
 * （football-data.co.uk を 1 表に正規化したもの。列名は README に従う）:
 *   Division, MatchDate (YYYY-MM-DD), MatchTime (HH:MM:SS), HomeTeam, AwayTeam,
 *   FTHome, FTAway, OddHome, OddDraw, OddAway（Bet365 の試合前オッズ）…
 * J1 は Division = "JAP"（2012〜）。欧州は E0 / SP1 / D1 / I1 / F1 など。
 *
 * ここは読み取りと型変換だけ。得点が欠けた行は捨てる（推測で埋めない）。
 * 時刻は CSV の値をそのまま UTC として扱う（順序と日付境界にしか使わないため）。
 */
import type { MatchRecord } from "./fit.ts";
import type { ProbabilityTriple } from "./scoring.ts";

export interface MatchWithOdds extends MatchRecord {
  division: string;
  /** Bet365 の試合前オッズ（小数）。無ければ null */
  odds: { home: number; draw: number; away: number } | null;
}

/** 最小限の CSV パーサ（ダブルクォート内のカンマ・改行なし前提。この表はそれで足りる） */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitLine(lines[0]);
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? "";
    out.push(row);
  }
  return out;
}

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface LoadOptions {
  /** 残す Division（省略で全部） */
  divisions?: string[];
}

/** 行 → MatchWithOdds。得点が無い行・日付が読めない行は捨てる */
export function loadMatches(rows: Record<string, string>[], opts: LoadOptions = {}): MatchWithOdds[] {
  const keep = opts.divisions ? new Set(opts.divisions) : null;
  const out: MatchWithOdds[] = [];
  for (const r of rows) {
    const division = r.Division ?? "";
    if (keep && !keep.has(division)) continue;
    const h = num(r.FTHome);
    const a = num(r.FTAway);
    if (h === null || a === null) continue;
    const time = r.MatchTime && /^\d\d:\d\d(:\d\d)?$/.test(r.MatchTime) ? r.MatchTime : "00:00:00";
    const date = `${r.MatchDate}T${time.length === 5 ? `${time}:00` : time}Z`;
    if (Number.isNaN(Date.parse(date))) continue;
    const oh = num(r.OddHome);
    const od = num(r.OddDraw);
    const oa = num(r.OddAway);
    out.push({
      division,
      date,
      home: r.HomeTeam,
      away: r.AwayTeam,
      homeGoals: Math.round(h),
      awayGoals: Math.round(a),
      odds: oh && od && oa && oh > 1 && od > 1 && oa > 1 ? { home: oh, draw: od, away: oa } : null,
    });
  }
  return out;
}

/**
 * オッズ → 含意確率。1/odds を合計 1 に正規化する（ブックの控除を按分で除く。
 * VORTE EV の市場ベンチマークと同じ「単純正規化」。Shin 法等の高度な除去は採らない）。
 */
export function impliedProbabilities(odds: { home: number; draw: number; away: number }): ProbabilityTriple {
  const inv = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const s = inv[0] + inv[1] + inv[2];
  return [inv[0] / s, inv[1] / s, inv[2] / s];
}
