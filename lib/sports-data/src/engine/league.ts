/**
 * League scoping — the ONE place that says how MLB and NPB differ
 * operationally.
 *
 * The prediction engine (run model, Monte Carlo, decision, EV, calibration,
 * settlement, reporting) is league-agnostic math; what actually differs
 * between leagues is the daily routine around it:
 *
 *   - WHERE the store lives. Each league keeps its own slates, locks,
 *     results, history and — critically — its own learned calibration.
 *     MLB's shrinks were earned on MLB bets; letting NPB games teach the
 *     MLB tail (or start from its conclusions) would blend two different
 *     books into one unfalsifiable record. MLB keeps the historical `data/`
 *     directory unchanged; NPB gets a sibling `data-npb/`.
 *
 *   - WHEN the day locks. MLB games are played overnight JST (the slate's
 *     evening-before deadline is 22:59 JST on the slate date itself); NPB
 *     games are played ON the slate date in the JST afternoon/evening —
 *     weekend day games start 13:00 JST, so the safe market cut-off is
 *     12:59 JST the same day, and every result is final the same night.
 *
 *   - WHICH odds market to pull (The Odds API sport key).
 *
 * Everything here is configuration, not behaviour: deadline.ts consumes the
 * deadline shapes, the CLI consumes the directory name and sport key.
 */

import type { LeagueDeadlines } from "./deadline";

export type League = "mlb" | "npb";

export interface LeagueConfig {
  readonly league: League;
  /** Human-readable label for reports and errors. */
  readonly label: string;
  /**
   * Store directory name under the package root. MLB keeps the historical
   * plain `data` — renaming it would orphan two years of committed record.
   */
  readonly dataDirName: string;
  /** The Odds API sport key for this league's markets. */
  readonly oddsSportKey: string;
  readonly deadlines: LeagueDeadlines;
}

export const MLB_CONFIG: LeagueConfig = {
  league: "mlb",
  label: "MLB",
  dataDirName: "data",
  oddsSportKey: "baseball_mlb",
  deadlines: {
    // 22:59 JST on the slate date = the evening before those games are
    // played (they run overnight JST); market closes 23:00 JST.
    prediction: { hour: 22, minute: 59, dayOffset: 0 },
    // All final by 16:00 JST the day after the slate date.
    results: { hour: 16, minute: 0, dayOffset: 1 },
  },
};

export const NPB_CONFIG: LeagueConfig = {
  league: "npb",
  label: "NPB",
  dataDirName: "data-npb",
  oddsSportKey: "baseball_npb",
  deadlines: {
    // NPB games are played ON the slate date: night games 17:45/18:00 JST,
    // weekend day games 13:00/14:00 JST. 12:59 JST the same day is the
    // latest cut-off that is safely before EVERY standard first pitch; a
    // later lock would let day-game picks be edited mid-game. Tighten or
    // relax here if the book's actual NPB close time turns out to differ.
    prediction: { hour: 12, minute: 59, dayOffset: 0 },
    // The last NPB game ends before midnight JST; results are due the next
    // morning.
    results: { hour: 9, minute: 0, dayOffset: 1 },
  },
};

const CONFIGS: Record<League, LeagueConfig> = {
  mlb: MLB_CONFIG,
  npb: NPB_CONFIG,
};

export class LeagueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeagueError";
  }
}

/**
 * Resolve a league from a CLI flag / env value. Absent means MLB — every
 * existing workflow, cron and hand-typed command predates the concept and
 * must keep meaning what it always meant.
 */
export function resolveLeague(raw: string | undefined | null): LeagueConfig {
  if (raw == null || raw === "") return MLB_CONFIG;
  const key = raw.toLowerCase() as League;
  const cfg = CONFIGS[key];
  if (!cfg) {
    throw new LeagueError(
      `Unknown league "${raw}" — expected one of: ${Object.keys(CONFIGS).join(", ")}`,
    );
  }
  return cfg;
}
