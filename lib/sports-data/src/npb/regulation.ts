/**
 * End-of-9th ("regulation") scores from npb.jp — the handicap market's
 * settlement basis (NPB_REGULATION_9, settlement-rules.ts).
 *
 * Two pages, both DISCOVERED rather than guessed (npb-probe.yml, 2026-08-24):
 *   - the games index /games/<year>/ lists the last few days' games as
 *     <h6 class="date">8月21日（金）</h6> blocks of
 *     <a href="/scores/<year>/<MMDD>/<home>-<away>-<n>/"> links — the ONLY
 *     place per-game paths come from;
 *   - each game page carries #table_linescore: a <tr class="top"> (visitor,
 *     先攻) and <tr class="bottom"> (home, 後攻) with one <td> per inning,
 *     then 計/H/E totals, and 【試合終了】 in .game_info once final.
 *
 * Reading rules (policy Appendix A.3, "NPB_REGULATION_9"):
 *   - the regulation score is the sum of innings 1–9 for each side;
 *   - a bottom-of-the-9th `x` is an unplayed half (home led): 0 runs;
 *   - a sayonara half is written `<runs>x` (e.g. `2x`): those runs count;
 *   - a called game shows fewer played innings; the score at the call is
 *     the regulation score and `inningsPlayed` records how many;
 *   - extra innings are ignored for the regulation score but reported;
 *   - SELF-CHECK: a game with ≤ 9 innings must have regulation == 計 for
 *     both sides. A mismatch means the layout changed — refuse to guess.
 */

import { teamByBisCode, teamByFullName, type NpbTeam } from "./teams";
import { NpbParseError } from "./parse";

const text = (html: string): string =>
  html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/[\s　]+/g, " ").trim();

export interface NpbGameLink {
  /** YYYY-MM-DD (from the date heading; the year is the index page's year). */
  date: string;
  /** "/scores/2026/0821/g-c-15/" */
  path: string;
  home: NpbTeam;
  away: NpbTeam;
  gameNumber: number;
}

/** Game-page links from the games index, keyed by their date heading. */
export function parseNpbGameLinks(html: string, year: number): NpbGameLink[] {
  const out: NpbGameLink[] = [];
  const re = /<h6 class="date">\s*(\d{1,2})月(\d{1,2})日|href="(\/scores\/(\d{4})\/(\d{2})(\d{2})\/([a-z]+)-([a-z]+)-(\d+)\/)"/g;
  let date: string | null = null;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      date = `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
      continue;
    }
    const [, , , path, y, mo, d, homeCode, awayCode, n] = m;
    const pathDate = `${y}-${mo}-${d}`;
    if (date !== null && date !== pathDate) {
      throw new NpbParseError(`games index: link ${path} sits under heading ${date} — layout changed, refuse to guess`);
    }
    if (out.some((g) => g.path === path)) continue;
    out.push({ date: pathDate, path: path!, home: teamByBisCode(homeCode!), away: teamByBisCode(awayCode!), gameNumber: Number(n) });
  }
  if (out.length === 0) throw new NpbParseError("games index parsed to zero game links — layout changed?");
  return out;
}

export interface NpbLineScoreSide {
  name: string;
  /** Raw inning cells as printed ("0", "2", "x", "2x", "" …), innings 1..n. */
  innings: string[];
  /** 計 column. */
  total: number;
}

export interface NpbLineScore {
  /** 【試合終了】 present. */
  final: boolean;
  /** Number of inning columns printed. */
  inningColumns: number;
  top: NpbLineScoreSide; // visitor (先攻)
  bottom: NpbLineScoreSide; // home (後攻)
}

function side(rowHtml: string, which: string): NpbLineScoreSide {
  const th = /<th>([\s\S]*?)<\/th>/.exec(rowHtml);
  const name = th ? text((/<span class="hide_sp">([\s\S]*?)<\/span>/.exec(th[1]!) ?? [null, th[1]!])[1]!) : "";
  const tds = [...rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
  const innings = tds.filter((m) => !/class="total/.test(m[1]!)).map((m) => text(m[2]!));
  const totals = tds.filter((m) => /class="total-1"/.test(m[1]!)).map((m) => text(m[2]!));
  if (!name || totals.length !== 1 || !/^\d+$/.test(totals[0]!)) {
    throw new NpbParseError(`line score ${which} row: cannot read team/計 — layout changed, refuse to guess`);
  }
  return { name, innings, total: Number(totals[0]) };
}

export function parseNpbLineScore(html: string): NpbLineScore {
  const table = /<table id="tablefix_ls">([\s\S]*?)<\/table>/.exec(html);
  if (!table) throw new NpbParseError("no #tablefix_ls line score on the page — layout changed or not a game page");
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(table[1]!)?.[1] ?? "";
  const inningColumns = [...head.matchAll(/<th>\s*(\d+)\s*<\/th>/g)].length;
  const top = /<tr class="top">([\s\S]*?)<\/tr>/.exec(table[1]!);
  const bottom = /<tr class="bottom">([\s\S]*?)<\/tr>/.exec(table[1]!);
  if (inningColumns < 1 || !top || !bottom) throw new NpbParseError("line score has no innings/top/bottom rows — layout changed");
  const t = side(top[1]!, "top");
  const b = side(bottom[1]!, "bottom");
  if (t.innings.length !== inningColumns || b.innings.length !== inningColumns) {
    throw new NpbParseError(`line score: ${inningColumns} inning columns but rows have ${t.innings.length}/${b.innings.length} cells`);
  }
  return { final: /【試合終了】/.test(html), inningColumns, top: t, bottom: b };
}

/** Runs in one printed half-inning cell; null when the half was not played. */
export function runsInCell(cell: string): number | null {
  const c = cell.trim().toLowerCase();
  if (c === "" || c === "-" || c === "−") return null;
  if (c === "x") return null; // unplayed bottom half (home already ahead)
  const m = /^(\d+)x$/.exec(c);
  if (m) return Number(m[1]); // sayonara: the winning runs count
  if (/^\d+$/.test(c)) return Number(c);
  throw new NpbParseError(`unreadable inning cell "${cell}"`);
}

export interface RegulationReading {
  homeScore: number;
  awayScore: number;
  regulationInnings: 9;
  /** Innings in which at least one half was played. */
  inningsPlayed: number;
  /** Final totals as printed (計), for the record — never used for settlement under this rule. */
  finalHome: number;
  finalAway: number;
}

/** Regulation (end-of-9th) score with the ≤ 9-inning self-check. */
export function regulationFromLineScore(ls: NpbLineScore): RegulationReading {
  let played = 0;
  let home = 0;
  let away = 0;
  for (let i = 0; i < ls.inningColumns; i++) {
    const a = runsInCell(ls.top.innings[i]!);
    const h = runsInCell(ls.bottom.innings[i]!);
    if (a !== null || h !== null) played = i + 1;
    if (i < 9) {
      away += a ?? 0;
      home += h ?? 0;
    }
  }
  if (played <= 9 && (home !== ls.bottom.total || away !== ls.top.total)) {
    throw new NpbParseError(
      `regulation self-check failed: ${played} innings played but innings sum ${away}-${home} ≠ 計 ${ls.top.total}-${ls.bottom.total} — refuse to guess`,
    );
  }
  return { homeScore: home, awayScore: away, regulationInnings: 9, inningsPlayed: played, finalHome: ls.bottom.total, finalAway: ls.top.total };
}

export interface RegulationFetchResult {
  /** keyed by stringified gamePk */
  scores: Record<string, RegulationReading & { source: string; url: string; observedAt: string }>;
  /** games of the date that could not be read, with why */
  pending: { gamePk: number; matchup: string; reason: string }[];
}

/**
 * Regulation scores for the games of `date` that appear in `games` (the
 * lock's home/away full names + gamePk). The games index is fetched once;
 * a game without a link (index window passed) or not yet final is pending —
 * never filled from the posted final score.
 */
export async function fetchNpbRegulationScores(opts: {
  date: string;
  games: { gamePk: number; home: string; away: string }[];
  fetchPage: (url: string) => Promise<string>;
  now?: Date;
}): Promise<RegulationFetchResult> {
  const year = Number(opts.date.slice(0, 4));
  const index = await opts.fetchPage(`https://npb.jp/games/${year}/`);
  const links = parseNpbGameLinks(index, year).filter((l) => l.date === opts.date);
  const out: RegulationFetchResult = { scores: {}, pending: [] };
  for (const g of opts.games) {
    const matchup = `${g.away} @ ${g.home}`;
    const home = teamByFullName(g.home);
    const away = teamByFullName(g.away);
    const link = links.find((l) => l.home.teamId === home.teamId && l.away.teamId === away.teamId);
    if (!link) {
      out.pending.push({ gamePk: g.gamePk, matchup, reason: `no game page linked from /games/${year}/ for ${opts.date} (index window passed, or not scheduled)` });
      continue;
    }
    const url = `https://npb.jp${link.path}`;
    const html = await opts.fetchPage(url);
    const ls = parseNpbLineScore(html);
    if (!ls.final) {
      out.pending.push({ gamePk: g.gamePk, matchup, reason: "game page not marked 【試合終了】" });
      continue;
    }
    if (ls.bottom.name !== home.fullName || ls.top.name !== away.fullName) {
      throw new NpbParseError(`${url}: line score names ${ls.top.name} @ ${ls.bottom.name} do not match ${matchup}`);
    }
    out.scores[String(g.gamePk)] = {
      ...regulationFromLineScore(ls),
      source: "npb.jp score page",
      url,
      observedAt: (opts.now ?? new Date()).toISOString(),
    };
  }
  return out;
}
