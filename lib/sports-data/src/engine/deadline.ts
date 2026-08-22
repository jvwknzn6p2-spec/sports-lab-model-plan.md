/**
 * The two fixed cut-offs of the daily MLB routine, both stated in JST.
 *
 *   PREDICTION — 22:59 JST the evening before the games (the market itself
 *                closes at 23:00 JST; one minute of margin is kept).
 *   RESULTS    — 16:00 JST on the day the games finish. This is the LATEST
 *                acceptable time, not a schedule: settlement now polls and
 *                lands within ~2h of each game finishing (see
 *                handiedge-settle.yml), and this deadline is what the audit
 *                grades overdue slates against.
 *
 * ## Why "the evening before" is the slate's own date
 *
 * A slate is keyed by MLB's own calendar date (what statsapi calls the game
 * date). Those games begin around 17:00 UTC and run overnight, so in JST they
 * fall on the FOLLOWING morning: a 2024-07-25 slate is watched in Japan on the
 * 26th. The evening before them is therefore 22:59 JST on the 25th — the slate
 * date itself — and they are all final by 16:00 JST on the 26th, the day after.
 *
 * Concretely, for the 2024-07-25 slate:
 *   prediction  22:59 JST 07-25 = 13:59 UTC — earliest first pitch is 17:05 UTC
 *   results     16:00 JST 07-26 = 07:00 UTC — the last game ends around 06:00 UTC
 *
 * Both conversions are built from UTC arithmetic rather than the host's local
 * timezone, which is UTC on GitHub Actions and something else on a laptop. A
 * naive local-date comparison puts these deadlines a day out for anyone in JST,
 * because 22:59 and 16:00 JST both sit on a different UTC date than they read.
 */

/** Predictions are fixed at this JST time on the evening before the games. */
export const PREDICTION_DEADLINE_JST = { hour: 22, minute: 59 } as const;

/** Results, analysis, learning and saving are due at this JST time. */
export const RESULTS_DEADLINE_JST = { hour: 16, minute: 0 } as const;

/**
 * A deadline as a JST wall-clock time relative to the slate date.
 * `dayOffset` counts JST calendar days after the slate date (0 = the slate
 * date itself). Every function below takes a LeagueDeadlines and defaults to
 * the MLB shape, so all pre-league callers keep their exact behaviour.
 */
export interface JstDeadline {
  hour: number;
  minute: number;
  dayOffset: number;
}

export interface LeagueDeadlines {
  prediction: JstDeadline;
  results: JstDeadline;
}

/** The MLB routine, unchanged: lock the evening before, results next day. */
export const MLB_DEADLINES: LeagueDeadlines = {
  prediction: { ...PREDICTION_DEADLINE_JST, dayOffset: 0 },
  results: { ...RESULTS_DEADLINE_JST, dayOffset: 1 },
};

export const JST_UTC_OFFSET_MINUTES = 9 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}

/** Compose a JST wall-clock time on a calendar date into an absolute instant. */
export function jstInstant(
  date: string,
  time: { hour: number; minute: number },
): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new DeadlineError(`Date must be YYYY-MM-DD: "${date}"`);
  const [, y, mo, d] = m;
  return new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), time.hour, time.minute) -
      JST_UTC_OFFSET_MINUTES * 60_000,
  );
}

/** The JST calendar date, as YYYY-MM-DD, that an instant falls on. */
export function jstDateOf(instant: Date): string {
  return new Date(instant.getTime() + JST_UTC_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);
}

/** A JST wall-clock deadline `dayOffset` JST days after the slate date. */
function deadlineInstant(slateDate: string, d: JstDeadline): Date {
  const onDate = jstDateOf(
    new Date(
      jstInstant(slateDate, { hour: 12, minute: 0 }).getTime() +
        d.dayOffset * DAY_MS,
    ),
  );
  return jstInstant(onDate, { hour: d.hour, minute: d.minute });
}

/**
 * When the slate's predictions stop being editable. For MLB (the default)
 * that is 22:59 JST on the slate date — the evening before those games are
 * played; other leagues state their own shape (see league.ts).
 */
export function predictionDeadline(
  slateDate: string,
  deadlines: LeagueDeadlines = MLB_DEADLINES,
): Date {
  return deadlineInstant(slateDate, deadlines.prediction);
}

/**
 * When the slate's results are due — the LATEST acceptable time the audit
 * grades against, not a schedule. MLB default: 16:00 JST the day after.
 */
export function resultsDeadline(
  slateDate: string,
  deadlines: LeagueDeadlines = MLB_DEADLINES,
): Date {
  return deadlineInstant(slateDate, deadlines.results);
}

/** True once predictions for this slate may no longer change. */
export function isPredictionLocked(
  slateDate: string,
  now: Date,
  deadlines: LeagueDeadlines = MLB_DEADLINES,
): boolean {
  return now.getTime() >= predictionDeadline(slateDate, deadlines).getTime();
}

/** True once the slate's results may be settled, analysed, learned and saved. */
export function isResultsDue(
  slateDate: string,
  now: Date,
  deadlines: LeagueDeadlines = MLB_DEADLINES,
): boolean {
  return now.getTime() >= resultsDeadline(slateDate, deadlines).getTime();
}

/** Minutes until predictions freeze; negative once they have. */
export function minutesUntilPredictionLock(
  slateDate: string,
  now: Date,
  deadlines: LeagueDeadlines = MLB_DEADLINES,
): number {
  return Math.round(
    (predictionDeadline(slateDate, deadlines).getTime() - now.getTime()) /
      60_000,
  );
}

/**
 * ONE game's prediction deadline. With `leadMinutes` set (per-game-lock
 * leagues — NPB locks every pick 33 minutes before its own first pitch),
 * the deadline is the game's start time minus the lead; without it, or for
 * a game whose start time the schedule did not carry, the slate's fixed
 * deadline applies — which for NPB is deliberately the most conservative
 * value the rule could produce (33' before the earliest standard start).
 */
export function gamePredictionDeadline(
  slateDate: string,
  gameDateIso: string | null | undefined,
  deadlines: LeagueDeadlines = MLB_DEADLINES,
  leadMinutes?: number,
): Date {
  if (leadMinutes != null && gameDateIso) {
    const start = new Date(gameDateIso);
    if (!Number.isNaN(start.getTime())) {
      return new Date(start.getTime() - leadMinutes * 60_000);
    }
  }
  return predictionDeadline(slateDate, deadlines);
}

/**
 * Is a previously committed prediction FROZEN — i.e. must a re-run carry it
 * through unchanged? Three ways to be frozen, from strongest to weakest
 * evidence: it was already stamped final; its own stored deadline has
 * passed (the per-game rule — the pick standing at that instant is the
 * bet, whether or not a run has stamped it since); or, for a legacy row
 * that stored no deadline at all, the slate's fixed deadline has passed.
 */
export function predictionFrozen(
  prev: { final?: boolean | null; lockDeadline?: string | null },
  now: Date,
  slateFixedDeadlinePassed: boolean,
): boolean {
  if (prev.final) return true;
  if (prev.lockDeadline != null) {
    const d = new Date(prev.lockDeadline);
    if (!Number.isNaN(d.getTime())) return now.getTime() >= d.getTime();
  }
  return slateFixedDeadlinePassed;
}
