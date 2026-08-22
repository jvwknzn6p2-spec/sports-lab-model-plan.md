/**
 * Parsers for npb.jp — the official NPB site, which publishes no JSON API.
 *
 * Every selector below was written against LIVE page samples committed under
 * probe/npb/ (fetched 2026-08-22 by .github/workflows/npb-probe.yml), and
 * the unit tests parse those exact samples — the same fixtures-first pattern
 * the MLB client used when statsapi was egress-blocked.
 *
 * Sources parsed:
 *   - Monthly schedule (/games/<year>/schedule_<MM>_detail.html): one page
 *     carries EVERY league game's date, card (home team listed first — NPB
 *     lists the hosting club first), venue, start time, final score, the
 *     cancellation marker, and the announced starters (先発：) for upcoming
 *     games. Schedule, results and probables all come from here.
 *   - Team batting/pitching aggregates (tmb_c/tmb_p/tmp_c/tmp_p): full wOBA
 *     and FIP inputs per club, and — summed — the league totals the derived
 *     NPB constants are computed from.
 *   - Per-club individual pitching (idp1_<code>.html): season line for every
 *     pitcher on the club, used to resolve an announced starter's stats.
 *
 * Parsing philosophy: fail LOUD. A table whose header row does not carry the
 * expected column names in the expected order throws (npb.jp reordering a
 * table must break the fetch, not silently misread 三振 as 四球); an
 * unknown team name throws (see teams.ts).
 */

import type { RawBattingLine, RawPitchingLine } from "../sabermetrics";
import { teamByScheduleName, type NpbTeam } from "./teams";

export class NpbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpbParseError";
  }
}

/** Strip tags and collapse whitespace (npb.jp pads cells heavily). */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[\s　]+/g, " ")
    .trim();

const cells = (rowHtml: string): string[] =>
  [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]!));

const rows = (tableHtml: string): string[] =>
  [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);

const num = (s: string): number => {
  const v = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(v)) throw new NpbParseError(`Not a number: "${s}"`);
  return v;
};

/** Assert a header <th> sequence starts with the expected labels. */
function assertHeader(html: string, expected: string[], ctx: string): void {
  const ths = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    text(m[1]!),
  );
  for (let i = 0; i < expected.length; i++) {
    if (ths[i] !== expected[i]) {
      throw new NpbParseError(
        `${ctx}: column ${i} is "${ths[i] ?? "(missing)"}", expected "${expected[i]}" — npb.jp layout changed, refuse to guess`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Schedule (+ results + announced starters)
// ---------------------------------------------------------------------------

export interface NpbScheduleGame {
  /** YYYY-MM-DD */
  date: string;
  home: NpbTeam;
  away: NpbTeam;
  venue: string;
  /** "18:00" etc., null when the cell is blank. */
  startTime: string | null;
  /** Final scores when the page shows them; null before/during play. */
  homeScore: number | null;
  awayScore: number | null;
  cancelled: boolean;
  /** Announced starter surnames (先発：), home then away; null when absent. */
  homeStarterName: string | null;
  awayStarterName: string | null;
}

/**
 * Parse the monthly schedule page. `year`/`month` name the page being read
 * (the page prints only "8/22（土）"-style dates).
 */
export function parseNpbSchedule(
  html: string,
  year: number,
  month: number,
): NpbScheduleGame[] {
  const games: NpbScheduleGame[] = [];
  let currentDate: string | null = null;

  for (const row of rows(html)) {
    // A date header (<th … rowspan>8/22（土）</th>) opens a date group.
    const th = /<th[^>]*>([\s\S]*?)<\/th>/.exec(row);
    if (th) {
      const m = /^(\d{1,2})\/(\d{1,2})/.exec(text(th[1]!));
      if (m) {
        const mo = Number(m[1]);
        if (mo !== month) {
          throw new NpbParseError(
            `Schedule page for month ${month} contains date ${text(th[1]!)}`,
          );
        }
        currentDate = `${year}-${String(mo).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
      }
    }

    const team1 = /<div class="team1">([\s\S]*?)<\/div>/.exec(row);
    const team2 = /<div class="team2">([\s\S]*?)<\/div>/.exec(row);
    if (!team1 || !team2 || !currentDate) continue;

    const s1 = /<div class="score1">([\s\S]*?)<\/div>/.exec(row);
    const s2 = /<div class="score2">([\s\S]*?)<\/div>/.exec(row);
    const score = (m: RegExpExecArray | null): number | null => {
      const t = m ? text(m[1]!) : "";
      return /^\d+$/.test(t) ? Number(t) : null;
    };

    const place = /<div class="place">([\s\S]*?)<\/div>/.exec(row);
    const time = /<div class="time">([\s\S]*?)<\/div>/.exec(row);
    const timeText = time ? text(time[1]!) : "";

    // 先発：X rows exist only while the game is upcoming; after the game the
    // same column shows 勝/敗/Ｓ pitchers, which are NOT starters.
    const starters = [...row.matchAll(/<div class="pit">([\s\S]*?)<\/div>/g)]
      .map((m) => text(m[1]!))
      .filter((t) => t.startsWith("先発"))
      .map((t) => t.replace(/^先発[：:]\s*/, "").trim())
      .filter((t) => t.length > 0);

    games.push({
      date: currentDate,
      home: teamByScheduleName(text(team1[1]!)),
      away: teamByScheduleName(text(team2[1]!)),
      venue: place ? text(place[1]!) : "",
      startTime: /^\d{1,2}:\d{2}$/.test(timeText) ? timeText : null,
      homeScore: score(s1),
      awayScore: score(s2),
      cancelled: /class="cancel"/.test(row),
      homeStarterName: starters[0] ?? null,
      awayStarterName: starters[1] ?? null,
    });
  }
  if (games.length === 0) {
    throw new NpbParseError("Schedule page parsed to zero games — layout changed?");
  }
  return games;
}

// ---------------------------------------------------------------------------
// Team aggregates
// ---------------------------------------------------------------------------

const TEAM_BATTING_HEADER = [
  "チーム", "打率", "試合", "打席", "打数", "得点", "安打", "二塁打",
  "三塁打", "本塁打", "塁打", "打点", "盗塁", "盗塁刺", "犠打", "犠飛",
  "四球", "故意四", "死球", "三振",
];

export interface NpbTeamBattingRow {
  team: NpbTeam;
  runs: number;
  line: RawBattingLine;
}

/** Parse one league's team batting table (tmb_c.html / tmb_p.html). */
export function parseNpbTeamBatting(html: string): NpbTeamBattingRow[] {
  assertHeader(html, TEAM_BATTING_HEADER, "team batting");
  const out: NpbTeamBattingRow[] = [];
  for (const row of rows(html)) {
    const c = cells(row);
    if (c.length < 23) continue;
    out.push({
      team: teamByScheduleName(c[0]!),
      runs: num(c[5]!),
      line: {
        plateAppearances: num(c[3]!),
        atBats: num(c[4]!),
        hits: num(c[6]!),
        doubles: num(c[7]!),
        triples: num(c[8]!),
        homeRuns: num(c[9]!),
        stolenBases: num(c[12]!),
        caughtStealing: num(c[13]!),
        sacFlies: num(c[15]!),
        baseOnBalls: num(c[16]!),
        intentionalWalks: num(c[17]!),
        hitByPitch: num(c[18]!),
        strikeOuts: num(c[19]!),
      },
    });
  }
  if (out.length !== 6) {
    throw new NpbParseError(
      `Team batting parsed ${out.length} clubs, expected 6 per league`,
    );
  }
  return out;
}

const TEAM_PITCHING_HEADER = [
  "チーム", "防御率", "試合", "勝利", "敗北", "セーブ", "ホールド", "ＨＰ",
  "完投", "完封勝", "無四球", "勝率", "打者", "投球回", "安打", "本塁打",
  "四球", "故意四", "死球", "三振",
];

export interface NpbTeamPitchingRow {
  team: NpbTeam;
  line: RawPitchingLine;
}

/**
 * Parse one league's team pitching table (tmp_c.html / tmp_p.html). The
 * 投球回 cell keeps npb.jp's integer/decimal spans, which `text` flattens to
 * the base-3 "1234.1" form RawPitchingLine already speaks (= 1234⅓).
 */
export function parseNpbTeamPitching(html: string): NpbTeamPitchingRow[] {
  assertHeader(html, TEAM_PITCHING_HEADER, "team pitching");
  const out: NpbTeamPitchingRow[] = [];
  for (const row of rows(html)) {
    const c = cells(row);
    if (c.length < 24) continue;
    out.push({
      team: teamByScheduleName(c[0]!),
      line: {
        inningsPitched: c[13]!.replace(/\s+/g, ""),
        battersFaced: num(c[12]!),
        hits: num(c[14]!),
        homeRuns: num(c[15]!),
        baseOnBalls: num(c[16]!),
        hitByPitch: num(c[18]!),
        strikeOuts: num(c[19]!),
        runs: num(c[22]!),
        earnedRuns: num(c[23]!),
      },
    });
  }
  if (out.length !== 6) {
    throw new NpbParseError(
      `Team pitching parsed ${out.length} clubs, expected 6 per league`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-club individual pitching
// ---------------------------------------------------------------------------

const CLUB_PITCHING_HEADER = [
  "選手", "登板", "勝利", "敗北", "セーブ", "ホールド", "ＨＰ", "完投",
  "完封勝", "無四球", "勝率", "打者", "投球回", "安打", "本塁打", "四球",
  "故意四", "死球", "三振",
];

export interface NpbPitcherRow {
  /** Full name with the club page's spacing collapsed: "赤星 優志". */
  name: string;
  /** Family name (the schedule announces starters by surname only). */
  familyName: string;
  games: number;
  line: RawPitchingLine;
}

/** Parse a club's individual pitching page (idp1_<code>.html). */
export function parseNpbClubPitching(html: string): NpbPitcherRow[] {
  assertHeader(html, CLUB_PITCHING_HEADER, "club pitching");
  const out: NpbPitcherRow[] = [];
  for (const row of rows(html)) {
    const c = cells(row);
    if (c.length < 24) continue;
    // Handedness markers (*, +) ride the name cell as <sup>; text() already
    // dropped the tags but the star may survive as a bare character.
    const name = c[0]!.replace(/^[*+＊＋]\s*/, "").trim();
    out.push({
      name,
      familyName: name.split(" ")[0]!,
      games: num(c[1]!),
      line: {
        inningsPitched: c[12]!.replace(/\s+/g, ""),
        battersFaced: num(c[11]!),
        hits: num(c[13]!),
        homeRuns: num(c[14]!),
        baseOnBalls: num(c[15]!),
        hitByPitch: num(c[17]!),
        strikeOuts: num(c[18]!),
        runs: num(c[21]!),
        earnedRuns: num(c[22]!),
      },
    });
  }
  if (out.length === 0) {
    throw new NpbParseError("Club pitching page parsed to zero pitchers");
  }
  return out;
}

/**
 * Resolve an announced starter (surname only) against the club's pitching
 * page. Exactly one family-name match is required: zero or several matches
 * return null and the caller flags the game — guessing between two 田中s
 * would fabricate a starter.
 */
export function matchStarter(
  surname: string,
  pitchers: NpbPitcherRow[],
): NpbPitcherRow | null {
  const hits = pitchers.filter((p) => p.familyName === surname.trim());
  return hits.length === 1 ? hits[0]! : null;
}
