/**
 * NPB availability and posted orders — the two inputs the league publishes
 * that the slate did not previously read.
 *
 * Both feed structures the engine ALREADY understands: the bundle's
 * `injuries` / `lineups` / `lineupBatting` maps are league-agnostic, and
 * step2 consumes them identically for either league. Nothing downstream had
 * to learn about NPB; this module just fills the same shapes.
 *
 * ## Availability (出場選手登録・登録抹消)
 *
 * NPB has no injured list. It has a registration list: a club may carry 29
 * registered players, and a DE-REGISTERED (登録抹消) player cannot be
 * re-registered for 10 days. That makes the公示 a HARDER availability
 * statement than an MLB injury report — it says the player is unavailable,
 * as a matter of rule, rather than guessing at "day-to-day". It says
 * nothing about WHY (injury, form, roster management), which is exactly why
 * it stays informational: inventing a penalty for a club because a name
 * left its roster would fabricate an input the feed does not contain. Same
 * rule the MLB IL detection follows.
 *
 * Because a de-registration lasts 10 days, "who is unavailable today" is
 * the union of the last N days' 抹消 lists minus anyone re-registered since
 * — which is why this reads a WINDOW of daily pages, not just today's.
 *
 * ## Posted orders
 *
 * A game page carries `<div id="player-order">` once the club posts its
 * lineup. Its URL slug (`h-b-17`) is not computable — npb.jp publishes no
 * browsable date index (a 2026-08-24 probe got 404 for /scores/<y>/<MMDD>/)
 * — so slugs are DISCOVERED from the games index and matched to the slate
 * by club pair. A game whose slug or order is missing keeps the team-season
 * baseline and is flagged; nothing is projected.
 */

import type { RawBattingLine } from "../sabermetrics";
import type { GameLineups } from "../features/lineup";
import type { IlPlayer } from "../sources/injuries-builder";
import {
  matchBatter,
  parseNpbClubBatting,
  parseNpbGameOrder,
  parseNpbRosterMoves,
  type NpbBatterRow,
} from "./parse";
import { fetchNpbPage, npbUrls } from "./slate";
import type { NpbTeam } from "./teams";

/**
 * How many days of 公示 to read. A de-registration bars a player for 10
 * days, so a 10-day window is the smallest one that cannot report a player
 * as available while the rule still holds him out.
 */
export const DEREGISTRATION_DAYS = 10;

const mmdd = (isoDate: string) => isoDate.slice(5).replace("-", "");

/** The `YYYY-MM-DD` dates of the `days` days ending at (and including) `date`. */
export function rosterWindow(date: string, days = DEREGISTRATION_DAYS): string[] {
  const end = new Date(`${date}T00:00:00Z`);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export interface NpbAvailabilityReport {
  /** Keyed by stringified teamId; present (possibly empty) for every club seen. */
  unavailable: Record<string, IlPlayer[]>;
  warnings: string[];
}

/**
 * Who is de-registered and not yet back, per club, as of `date`.
 *
 * Read oldest-first so a later re-registration cancels an earlier
 * 抹消 — a player sent down and recalled inside the window is available,
 * and reporting him as out would be as wrong as missing him.
 *
 * A day whose page cannot be fetched or parsed is WARNED and skipped, not
 * fatal: the window is a convenience for a flag that changes no number, and
 * failing a whole slate over one missing公示 would trade a real prediction
 * for an informational one.
 */
export async function buildNpbAvailability(
  date: string,
  fetchImpl: typeof fetch = fetch,
  days = DEREGISTRATION_DAYS,
): Promise<NpbAvailabilityReport> {
  const out = new Map<number, Map<string, IlPlayer>>();
  const warnings: string[] = [];
  const bucket = (team: NpbTeam) => {
    let m = out.get(team.teamId);
    if (!m) out.set(team.teamId, (m = new Map()));
    return m;
  };

  for (const day of rosterWindow(date, days)) {
    let moves;
    try {
      const html = await fetchNpbPage(npbUrls.rosterMoves(mmdd(day)), fetchImpl);
      moves = parseNpbRosterMoves(html);
    } catch (e) {
      warnings.push(
        `roster公示 for ${day} unavailable (${e instanceof Error ? e.message : String(e)}) — ` +
          `that day's moves are not reflected`,
      );
      continue;
    }
    for (const m of moves.deregistered) {
      bucket(m.team).set(m.playerId, {
        name: m.name,
        position: m.position,
        status: `登録抹消 ${moves.date}`,
      });
    }
    // Oldest-first ordering makes this the cancellation: a recall after the
    // 抹消 clears it, a 抹消 after a recall re-applies above.
    for (const m of moves.registered) bucket(m.team).delete(m.playerId);
  }

  const unavailable: Record<string, IlPlayer[]> = {};
  for (const [teamId, players] of out) {
    unavailable[String(teamId)] = [...players.values()];
  }
  return { unavailable, warnings };
}

/**
 * Map each slate game to its npb.jp URL slug, discovered from the games
 * index. Keyed by `<awayTeamId>-<homeTeamId>`; a pair the index does not
 * carry is simply absent (the caller flags that game).
 *
 * The index prints the slug as `<home>-<away>-<NN>` but the club identities
 * are not recoverable from the letters alone (`db` vs `d`, `h` vs `f`), so
 * this keys on the DATE and lets the caller match by date + club pair from
 * the order block itself, which names both clubs in full.
 */
export function parseGameSlugs(indexHtml: string, date: string): string[] {
  const day = mmdd(date);
  return [...indexHtml.matchAll(
    /href="\/scores\/(\d{4})\/(\d{4})\/([a-z]+-[a-z]+-\d+)\/"/g,
  )]
    .filter((m) => m[2] === day)
    .map((m) => m[3]!)
    .filter((slug, i, all) => all.indexOf(slug) === i);
}

export interface NpbLineupReport {
  /** Keyed by stringified gamePk. */
  lineups: Record<string, GameLineups>;
  /** Keyed by stringified synthetic batter id. */
  lineupBatting: Record<string, RawBattingLine>;
  warnings: string[];
}

/**
 * A synthetic, stable numeric id for an NPB batter.
 *
 * npb.jp player ids are numeric STRINGS with leading zeros that matter
 * (01705130); the engine keys bats by number. Parsing the id as a number
 * would collide two players whose ids differ only by a leading zero, so the
 * digits are folded with the club id instead — the same trick
 * `npbPitcherId` uses, and collisions are asserted at build time.
 */
export function npbBatterId(teamId: number, playerId: string): number {
  let h = 0;
  for (const ch of playerId) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
  return teamId * 10_000_000 + h;
}

/**
 * Fetch and resolve the posted orders for a slate.
 *
 * `games` carries each game's gamePk and the two clubs. Every failure mode
 * degrades to "no lineup for this game" with a warning — an unposted order
 * is the NORMAL pre-game state, and the engine already handles its absence
 * by keeping the team-season offense and flagging `lineup_not_posted`.
 */
export async function buildNpbLineups(
  opts: {
    date: string;
    year: number;
    games: readonly { gamePk: number; home: NpbTeam; away: NpbTeam }[];
    fetchImpl?: typeof fetch;
  },
): Promise<NpbLineupReport> {
  const f = opts.fetchImpl ?? fetch;
  const warnings: string[] = [];
  const lineups: Record<string, GameLineups> = {};
  const lineupBatting: Record<string, RawBattingLine> = {};
  if (opts.games.length === 0) return { lineups, lineupBatting, warnings };

  let slugs: string[];
  try {
    const index = await fetchNpbPage(npbUrls.gamesIndex(opts.year), f);
    slugs = parseGameSlugs(index, opts.date);
  } catch (e) {
    warnings.push(
      `games index unavailable (${e instanceof Error ? e.message : String(e)}) — ` +
        `no posted orders read; every game keeps its team-season offense`,
    );
    return { lineups, lineupBatting, warnings };
  }
  if (slugs.length === 0) {
    warnings.push(
      `the games index lists no game for ${opts.date} — no posted orders read`,
    );
    return { lineups, lineupBatting, warnings };
  }

  // Club batting pages are per club and shared across that club's games, so
  // they are fetched once and reused.
  const battingCache = new Map<number, NpbBatterRow[]>();
  const clubBatting = async (team: NpbTeam): Promise<NpbBatterRow[] | null> => {
    const hit = battingCache.get(team.teamId);
    if (hit) return hit;
    try {
      const html = await fetchNpbPage(
        npbUrls.clubBatting(opts.year, team.bisCode),
        f,
      );
      const rows = parseNpbClubBatting(html);
      battingCache.set(team.teamId, rows);
      return rows;
    } catch (e) {
      warnings.push(
        `${team.fullName}: club batting page unavailable ` +
          `(${e instanceof Error ? e.message : String(e)})`,
      );
      return null;
    }
  };

  // Resolve every slug ONCE: the order block names both clubs in full, which
  // is what identifies the game — the slug's letters do not, on their own.
  const byPair = new Map<string, Awaited<ReturnType<typeof parseNpbGameOrder>>>();
  for (const slug of slugs) {
    try {
      const html = await fetchNpbPage(
        npbUrls.gameOrder(opts.year, mmdd(opts.date), slug),
        f,
      );
      const order = parseNpbGameOrder(html);
      if (!order) continue;
      byPair.set(`${order.away.team.teamId}-${order.home.team.teamId}`, order);
    } catch (e) {
      warnings.push(
        `game ${slug}: page unavailable ` +
          `(${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  for (const game of opts.games) {
    const order = byPair.get(`${game.away.teamId}-${game.home.teamId}`);
    if (!order) {
      warnings.push(
        `${game.away.scheduleName} @ ${game.home.scheduleName}: no order posted ` +
          `yet — team-season offense stands`,
      );
      continue;
    }
    const sides: GameLineups = { home: [], away: [] };
    for (const [key, side] of [
      ["away", order.away],
      ["home", order.home],
    ] as const) {
      const roster = await clubBatting(side.team);
      for (const slot of side.slots) {
        if (slot.slot === null) continue; // the pitcher's row
        const id = npbBatterId(side.team.teamId, slot.playerId);
        sides[key].push({ playerId: id, name: slot.name });
        const hit = roster ? matchBatter(slot.name, roster) : null;
        if (hit) {
          lineupBatting[String(id)] = hit.line;
        } else if (roster) {
          // Left absent on purpose: the engine fills an unmatched bat at
          // league-average wOBA with zero sample and flags it, which is the
          // least-assuming prior. Guessing a team-mate would be worse.
          warnings.push(
            `${side.team.scheduleName}: posted bat "${slot.name}" not uniquely ` +
              `matched on the club batting page — filled at league average, flagged`,
          );
        }
      }
    }
    lineups[String(game.gamePk)] = sides;
  }
  return { lineups, lineupBatting, warnings };
}
