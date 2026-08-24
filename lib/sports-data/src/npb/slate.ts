/**
 * NPB slate builder — assembles the same FixtureBundle the MLB fetch
 * produces, from npb.jp pages (see parse.ts for sources and samples).
 *
 * Honesty rules, identical to the MLB path:
 *   - An announced starter that cannot be UNIQUELY matched on the club's
 *     pitching page stays null: the game runs with probablePitcherId null
 *     and the assembler downgrades it (no_probable_pitcher), exactly as an
 *     MLB game with no probable does. Nothing is guessed.
 *   - The bullpen line is the club's TEAM pitching total minus the day's
 *     matched starter's own line — every reliever plus the other starters.
 *     That overweights rotation quality slightly, but every number in it is
 *     real; inventing a reliever split npb.jp does not publish would not
 *     be. Recorded in the slate's `notes` for the audit trail.
 *   - Recent form and park factors are DERIVED from the season's own game
 *     log (npb/context.ts); weather is attached by fetch-slate at the 12
 *     main parks (npb/weather.ts). Workloads, IL and lineups remain ABSENT
 *     (all optional in the bundle): the run model treats them as neutral,
 *     and nothing pretends otherwise.
 *
 * Synthetic ids (npb.jp has none):
 *   gamePk   = 9YYYYMMDDHH where HH is the home club's 2-digit id suffix —
 *              unique (one home game per club per day) and stable across
 *              re-fetches.
 *   pitcher  = teamId·100000 + fnv1a(full name) mod 100000, collision-
 *              checked per club (a collision throws; it has never occurred
 *              on a 32-man staff).
 */

import type { NormalizedGame } from "../mlb/parse";
import {
  inningsToDecimal,
  type RawPitchingLine,
} from "../sabermetrics";
import type { FixtureBundle } from "../sources/fixture-source";
import { deriveNpbConstants, npbSeasonKey } from "./constants";
import { buildNpbForms, buildNpbParkFactors, venueIdFor } from "./context";
import {
  matchStarter,
  parseNpbClubPitching,
  parseNpbSchedule,
  parseNpbTeamBatting,
  parseNpbTeamPitching,
  type NpbPitcherRow,
  type NpbScheduleGame,
} from "./parse";
import type { NpbTeam } from "./teams";

export class NpbFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpbFetchError";
  }
}

const BASE = "https://npb.jp";

export const npbUrls = {
  scheduleMonth: (year: number, month: number) =>
    `${BASE}/games/${year}/schedule_${String(month).padStart(2, "0")}_detail.html`,
  teamBatting: (year: number, league: "c" | "p") =>
    `${BASE}/bis/${year}/stats/tmb_${league}.html`,
  teamPitching: (year: number, league: "c" | "p") =>
    `${BASE}/bis/${year}/stats/tmp_${league}.html`,
  clubPitching: (year: number, bisCode: string) =>
    `${BASE}/bis/${year}/stats/idp1_${bisCode}.html`,
  /** Per-club individual BATTING — the season line behind each posted bat. */
  clubBatting: (year: number, bisCode: string) =>
    `${BASE}/bis/${year}/stats/idb1_${bisCode}.html`,
  /**
   * One game's page, which carries the posted batting order. `mmdd` is the
   * JST game date and `code` the `<home>-<away>-<NN>` slug the games index
   * links (e.g. "h-b-17"). There is NO browsable index above this: a 2026-08-24
   * probe got 404 for /scores/<year>/<MMDD>/ and a JS redirect for /scores/,
   * so the slug must come from a page that linked it, never from arithmetic.
   */
  gameOrder: (year: number, mmdd: string, code: string) =>
    `${BASE}/scores/${year}/${mmdd}/${code}/`,
  /** A day's 出場選手登録・登録抹消 公示 — NPB's IL-equivalent feed. */
  rosterMoves: (mmdd: string) =>
    `${BASE}/announcement/roster/roster_${mmdd}.html`,
};

/** Fetch one npb.jp page as text. Fail-loud; injectable for tests. */
export async function fetchNpbPage(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; HandiEdge/1.0)" },
    });
    if (!res.ok) {
      throw new NpbFetchError(`${url} returned ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new NpbFetchError(`${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

export function npbPitcherId(teamId: number, fullName: string): number {
  return teamId * 100_000 + (fnv1a(fullName) % 100_000);
}

export function npbGamePk(date: string, home: NpbTeam): number {
  const suffix = String(home.teamId % 100).padStart(2, "0");
  return Number(`9${date.replace(/-/g, "")}${suffix}`);
}

/** Subtract the starter's own line from the club total (floored at zero). */
export function teamMinusStarter(
  team: RawPitchingLine,
  starter: RawPitchingLine,
): RawPitchingLine {
  const n = (a: number | undefined, b: number | undefined) =>
    Math.max(0, (a ?? 0) - (b ?? 0));
  const ipThirds = Math.max(
    0,
    Math.round(inningsToDecimal(team.inningsPitched) * 3) -
      Math.round(inningsToDecimal(starter.inningsPitched) * 3),
  );
  const whole = Math.floor(ipThirds / 3);
  const rem = ipThirds % 3;
  return {
    inningsPitched: rem === 0 ? String(whole) : `${whole}.${rem}`,
    battersFaced: n(team.battersFaced, starter.battersFaced),
    strikeOuts: n(team.strikeOuts, starter.strikeOuts),
    baseOnBalls: n(team.baseOnBalls, starter.baseOnBalls),
    hitByPitch: n(team.hitByPitch, starter.hitByPitch),
    homeRuns: n(team.homeRuns, starter.homeRuns),
    hits: n(team.hits, starter.hits),
    earnedRuns: n(team.earnedRuns, starter.earnedRuns),
    runs: n(team.runs, starter.runs),
  };
}

export interface NpbSlateReport {
  bundle: FixtureBundle;
  /** Games on other dates in the same month page (context, not the slate). */
  monthGameCount: number;
  notes: string[];
}

export interface BuildNpbSlateOptions {
  date: string; // YYYY-MM-DD
  fetchImpl?: typeof fetch;
  now?: Date;
}

/** Fetch + assemble the NPB slate for one date. */
export async function buildNpbSlate(
  opts: BuildNpbSlateOptions,
): Promise<NpbSlateReport> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opts.date);
  if (!m) throw new NpbFetchError(`date must be YYYY-MM-DD: "${opts.date}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const f = opts.fetchImpl ?? fetch;
  const notes: string[] = [];

  const [scheduleHtml, tmbC, tmbP, tmpC, tmpP] = await Promise.all([
    fetchNpbPage(npbUrls.scheduleMonth(year, month), f),
    fetchNpbPage(npbUrls.teamBatting(year, "c"), f),
    fetchNpbPage(npbUrls.teamBatting(year, "p"), f),
    fetchNpbPage(npbUrls.teamPitching(year, "c"), f),
    fetchNpbPage(npbUrls.teamPitching(year, "p"), f),
  ]);

  const monthGames = parseNpbSchedule(scheduleHtml, year, month);
  const todays = monthGames.filter(
    (g) => g.date === opts.date && !g.cancelled,
  );

  // The season's earlier month pages feed recent form and the derived park
  // factors. Each is fail-soft (a missing/unparseable month narrows the
  // context sample and says so) — only the CURRENT month, fetched above, is
  // load-bearing for the slate itself. NPB's season opens in March.
  const seasonGames: NpbScheduleGame[] = [...monthGames];
  const earlier = [];
  for (let m = 3; m < month; m++) earlier.push(m);
  await Promise.all(
    earlier.map(async (m) => {
      try {
        const html = await fetchNpbPage(npbUrls.scheduleMonth(year, m), f);
        seasonGames.push(...parseNpbSchedule(html, year, m));
      } catch (err) {
        notes.push(
          `context: month ${m} page unavailable (${err instanceof Error ? err.message : String(err)}) — form/park sample narrowed`,
        );
      }
    }),
  );
  const batting = [...parseNpbTeamBatting(tmbC), ...parseNpbTeamBatting(tmbP)];
  const pitching = [
    ...parseNpbTeamPitching(tmpC),
    ...parseNpbTeamPitching(tmpP),
  ];
  const battingByTeam = new Map(batting.map((b) => [b.team.teamId, b]));
  const pitchingByTeam = new Map(pitching.map((p) => [p.team.teamId, p]));

  // Derived NPB environment (both leagues pooled — see npb/constants.ts).
  const leagueConstants = deriveNpbConstants(
    year,
    batting.map((b) => b.line),
    pitching.map((p) => p.line),
    batting.reduce((a, b) => a + b.runs, 0),
  );

  // One club-pitching page per club playing today.
  const clubs = new Map<number, NpbTeam>();
  for (const g of todays) {
    clubs.set(g.home.teamId, g.home);
    clubs.set(g.away.teamId, g.away);
  }
  const clubPitchers = new Map<number, NpbPitcherRow[]>();
  await Promise.all(
    [...clubs.values()].map(async (team) => {
      const html = await fetchNpbPage(npbUrls.clubPitching(year, team.bisCode), f);
      const rows = parseNpbClubPitching(html);
      // Collision check for the synthetic pitcher ids (see module doc).
      const ids = new Set<number>();
      for (const r of rows) {
        const id = npbPitcherId(team.teamId, r.name);
        if (ids.has(id)) {
          throw new NpbFetchError(
            `Pitcher id collision on ${team.fullName}: ${r.name}`,
          );
        }
        ids.add(id);
      }
      clubPitchers.set(team.teamId, rows);
    }),
  );

  const games: NormalizedGame[] = [];
  const starters: Record<string, RawPitchingLine> = {};
  const bundleBatting: Record<string, ReturnType<typeof battingLineOf>> = {};
  const bullpens: Record<string, RawPitchingLine> = {};

  function battingLineOf(teamId: number) {
    const row = battingByTeam.get(teamId);
    if (!row) throw new NpbFetchError(`No team batting for teamId ${teamId}`);
    return row.line;
  }

  const resolveSide = (
    team: NpbTeam,
    starterName: string | null,
    game: NpbScheduleGame,
  ) => {
    let pitcherId: number | null = null;
    let pitcherName: string | null = null;
    const roster = clubPitchers.get(team.teamId) ?? [];
    if (starterName) {
      const hit = matchStarter(starterName, roster);
      if (hit) {
        pitcherId = npbPitcherId(team.teamId, hit.name);
        pitcherName = hit.name;
        starters[String(pitcherId)] = hit.line;
      } else {
        notes.push(
          `${game.date} ${team.scheduleName}: announced starter "${starterName}" ` +
            `not uniquely matched on the club pitching page — game runs with ` +
            `no probable (downgraded), nothing guessed`,
        );
      }
    }
    // Bullpen = club total minus today's starter (see module doc).
    const clubTotal = pitchingByTeam.get(team.teamId);
    if (clubTotal) {
      const starterLine =
        pitcherId !== null ? starters[String(pitcherId)] : undefined;
      bullpens[String(team.teamId)] = starterLine
        ? teamMinusStarter(clubTotal.line, starterLine)
        : clubTotal.line;
    }
    bundleBatting[String(team.teamId)] = battingLineOf(team.teamId);
    return { pitcherId, pitcherName };
  };

  for (const g of todays) {
    const home = resolveSide(g.home, g.homeStarterName, g);
    const away = resolveSide(g.away, g.awayStarterName, g);
    const gameDate = g.startTime
      ? new Date(`${g.date}T${g.startTime}:00+09:00`).toISOString()
      : null;
    games.push({
      gamePk: npbGamePk(g.date, g.home),
      gameDate,
      status: g.homeScore !== null ? "Final?" : "Scheduled",
      abstractState: g.homeScore !== null ? null : "Preview",
      gameType: "R",
      // A 地方開催 game's venue is not one of the 12 main parks: id stays
      // null and the game runs park-neutral (its derived factor would have
      // been regressed to ~100 anyway on a handful of games).
      venue: { id: venueIdFor(g.venue), name: g.venue || g.home.homeVenue },
      home: {
        teamId: g.home.teamId,
        teamName: g.home.fullName,
        probablePitcherId: home.pitcherId,
        probablePitcherName: home.pitcherName,
        score: g.homeScore,
      },
      away: {
        teamId: g.away.teamId,
        teamName: g.away.fullName,
        probablePitcherId: away.pitcherId,
        probablePitcherName: away.pitcherName,
        score: g.awayScore,
      },
    });
  }

  // Season-context features from the same game log (see npb/context.ts).
  const forms = buildNpbForms(seasonGames, opts.date);
  const parks = buildNpbParkFactors(seasonGames, opts.date);
  notes.push(
    `Context: recent form for ${Object.keys(forms).length} club(s) and ` +
      `park factors for ${Object.keys(parks.parkFactors).length} park(s) ` +
      `derived from ${seasonGames.length} scheduled game(s) this season ` +
      `(league ${parks.leagueRunsPerGame} runs/game).`,
  );
  notes.push(
    "NPB inputs: bullpen = club pitching total minus today's matched " +
      "starter (npb.jp publishes no reliever split); workloads, IL and " +
      "lineups are absent and treated as neutral. Weather is attached by " +
      "fetch-slate at the 12 main parks (see npb/weather.ts).",
  );

  return {
    bundle: {
      date: opts.date,
      season: npbSeasonKey(year),
      fetchedAt: (opts.now ?? new Date()).toISOString(),
      games,
      starters,
      batting: bundleBatting,
      bullpens,
      forms,
      parkFactors: parks.parkFactors,
      leagueConstants,
    },
    monthGameCount: monthGames.length,
    notes,
  };
}

/**
 * Final scores for a date from the month schedule page. A game counts as
 * final only when both scores are shown AND `now` is past 3.5 hours after
 * first pitch (the page shows no explicit final marker; the time guard
 * keeps a live linescore from settling early). NPB ties are real results
 * (score1 === score2) and settle as pushes downstream.
 */
export async function fetchNpbResults(opts: {
  date: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{
  results: Record<string, { homeScore: number; awayScore: number }>;
  pending: string[];
  cancelled: string[];
}> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opts.date);
  if (!m) throw new NpbFetchError(`date must be YYYY-MM-DD: "${opts.date}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const html = await fetchNpbPage(
    npbUrls.scheduleMonth(year, month),
    opts.fetchImpl ?? fetch,
  );
  const now = opts.now ?? new Date();
  const results: Record<string, { homeScore: number; awayScore: number }> = {};
  const pending: string[] = [];
  const cancelled: string[] = [];
  for (const g of parseNpbSchedule(html, year, month)) {
    if (g.date !== opts.date) continue;
    const label = `${g.away.scheduleName} @ ${g.home.scheduleName}`;
    if (g.cancelled) {
      cancelled.push(label);
      continue;
    }
    const start = g.startTime
      ? new Date(`${g.date}T${g.startTime}:00+09:00`)
      : new Date(`${g.date}T18:00:00+09:00`);
    const surelyOver = now.getTime() - start.getTime() > 3.5 * 60 * 60 * 1000;
    if (g.homeScore !== null && g.awayScore !== null && surelyOver) {
      results[String(npbGamePk(g.date, g.home))] = {
        homeScore: g.homeScore,
        awayScore: g.awayScore,
      };
    } else {
      pending.push(label);
    }
  }
  return { results, pending, cancelled };
}
