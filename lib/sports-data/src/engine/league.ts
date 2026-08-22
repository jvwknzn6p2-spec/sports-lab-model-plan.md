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
  /**
   * When set, each game's prediction locks THIS many minutes before its own
   * first pitch (per-game deadlines) instead of at the fixed
   * `deadlines.prediction` time — which then serves only as the fallback for
   * a game whose start time the schedule did not carry. Unset = the whole
   * slate locks at the fixed time (MLB).
   */
  readonly perGameLockLeadMinutes?: number;
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
  // Each NPB pick locks 33 minutes before ITS OWN first pitch — day game,
  // twilight or night game alike (owner's rule, 2026-08-22). The fixed
  // prediction time below is only the fallback for a game with no start
  // time on the schedule: 12:27 JST = 33 minutes before the earliest
  // standard first pitch (13:00 weekend day games), i.e. the most
  // conservative deadline the rule could produce.
  perGameLockLeadMinutes: 33,
  deadlines: {
    prediction: { hour: 12, minute: 27, dayOffset: 0 },
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
