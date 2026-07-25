/**
 * Our domain model for a scheduled game.
 *
 * Deliberately not the API's shape. Downstream code (the baseline model, the
 * simulator, the daily report) depends on this, so an upstream change is
 * absorbed in `normalize.ts` instead of rippling outward.
 */

/**
 * Normalised game state.
 *
 * The API reports state three ways and uses more than a dozen `detailedState`
 * strings. Only these distinctions change what we do.
 */
export type GameStatus =
  | "scheduled"
  | "pregame"
  | "live"
  | "final"
  | "postponed"
  | "cancelled"
  | "suspended"
  | "delayed"
  | "unknown";

/** MLB game types. `R` is the regular season; everything else needs care. */
export type GameType =
  | "regular"
  | "spring"
  | "postseason"
  | "allstar"
  | "exhibition"
  | "other";

export type DoubleHeaderKind = "none" | "traditional" | "split";

/**
 * A reason this game's data is incomplete or unusual.
 *
 * The plan's rule is to flag and downgrade rather than quietly substitute a
 * plausible number (§3). These flags are what the confidence rank (§4.3) and
 * the Data Auditor agent (§4.5) consume.
 */
export type DataFlag =
  | "postponed"
  | "cancelled"
  | "suspended"
  | "delayed"
  | "in-progress"
  | "completed"
  | "start-time-tbd"
  | "missing-home-pitcher"
  | "missing-away-pitcher"
  | "non-regular-season"
  | "doubleheader"
  | "shortened-game"
  | "missing-venue"
  | "resumed-game";

export interface ProbablePitcher {
  readonly id: number;
  readonly fullName: string;
}

export interface TeamSide {
  readonly id: number;
  readonly name: string;
  readonly wins: number | null;
  readonly losses: number | null;
  /** Null until MLB announces the starter — usually the day before, sometimes not at all. */
  readonly probablePitcher: ProbablePitcher | null;
  /** Null before the game starts. */
  readonly score: number | null;
}

export interface Venue {
  readonly id: number;
  readonly name: string;
}

export interface ScheduledGame {
  /** MLB's globally unique game id. The primary key everywhere downstream. */
  readonly gamePk: number;

  /**
   * Human-readable stable key, e.g. `"2026-07-25:LAA@HOU:g1"`.
   *
   * Includes the game number so the two halves of a doubleheader never collide.
   * For anything machine-facing prefer `gamePk`.
   */
  readonly key: string;

  /**
   * Seed for the Monte Carlo simulator, derived from `gamePk`.
   *
   * Deriving it from teams and date would collide on doubleheaders — the same
   * two teams on the same day are two different games, and they would share a
   * random stream. `gamePk` is unique and stable, so re-running the pipeline
   * reproduces the morning's numbers exactly.
   *
   * Reusing the seed across the morning run and an evening refresh is
   * intentional: the two runs then share random draws, so any change in the
   * output comes from changed inputs rather than from simulation noise.
   */
  readonly seed: string;

  readonly gameType: GameType;
  readonly season: string;

  /** Scheduled first pitch as an ISO UTC timestamp. */
  readonly startTime: string;

  /** The calendar date MLB assigns the game, `YYYY-MM-DD`. */
  readonly officialDate: string;

  readonly status: GameStatus;
  /** The API's own wording, kept verbatim for debugging and display. */
  readonly detailedState: string;
  /** Populated for postponements — e.g. `"Rain"`. */
  readonly statusReason: string | null;

  readonly home: TeamSide;
  readonly away: TeamSide;
  readonly venue: Venue | null;

  readonly doubleHeader: DoubleHeaderKind;
  readonly gameNumber: number;
  readonly scheduledInnings: number;
  readonly seriesDescription: string | null;
  readonly dayNight: "day" | "night" | null;

  /**
   * Whether this game should get a prediction today.
   *
   * False for anything already started or finished, and for postponements and
   * cancellations. Missing data (an unannounced starter) does *not* make a game
   * unpredictable — it makes it a low-confidence prediction, which is the
   * ranking step's job, not this one's.
   */
  readonly isPredictable: boolean;

  readonly flags: readonly DataFlag[];
}

export interface ScheduleSnapshot {
  /** The date requested, `YYYY-MM-DD`. */
  readonly date: string;
  readonly games: readonly ScheduledGame[];

  /** When this snapshot was taken. Required for backtesting and for tracking line movement. */
  readonly fetchedAt: string;

  readonly counts: {
    readonly total: number;
    readonly predictable: number;
    readonly postponed: number;
    readonly missingPitchers: number;
  };
}
