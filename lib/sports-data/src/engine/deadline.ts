/**
 * When a prediction stops being editable.
 *
 * A pick is only honest if it was fixed before the game could inform it. The
 * rule here is per-GAME, not per-slate: each prediction is final 9 minutes
 * before its own first pitch. A slate with a 12:00 day game and an 18:00
 * nighter therefore has two different cut-offs, and re-running the pipeline at
 * 15:00 must leave the day game exactly as it was locked while still being
 * free to refresh the nighter with newer information.
 *
 * NPB start times (JST):
 *   night — 18:00 as a rule
 *   day   — 12:00 to 15:00, and in practice only on weekends and holidays
 *
 * Settlement, error analysis, learning and saving run on a separate, slate-wide
 * deadline at 23:13 JST on the day of the games.
 */

/** Minutes before first pitch at which a prediction becomes final. */
export const LOCK_MINUTES_BEFORE_START = 9;

/** Slate-wide cut-off for settle → analyse → learn → save, in JST. */
export const SETTLEMENT_DEADLINE_JST = { hour: 23, minute: 13 } as const;

export const JST_UTC_OFFSET_MINUTES = 9 * 60;

export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}

/**
 * The moment a game's prediction is frozen: first pitch minus 9 minutes.
 */
export function lockDeadline(gameStart: string | Date): Date {
  const start = gameStart instanceof Date ? gameStart : new Date(gameStart);
  if (Number.isNaN(start.getTime())) {
    throw new DeadlineError(`Unreadable game start: ${String(gameStart)}`);
  }
  return new Date(start.getTime() - LOCK_MINUTES_BEFORE_START * 60_000);
}

/** True once the prediction for this game may no longer change. */
export function isFinalized(gameStart: string | Date, now: Date): boolean {
  return now.getTime() >= lockDeadline(gameStart).getTime();
}

/** Minutes remaining before the pick freezes; negative once it has. */
export function minutesUntilLock(gameStart: string | Date, now: Date): number {
  return Math.round(
    (lockDeadline(gameStart).getTime() - now.getTime()) / 60_000,
  );
}

/**
 * The settle/analyse/learn cut-off for a slate date, as an absolute instant.
 * `date` is the slate's own date in JST (YYYY-MM-DD), which is the day the
 * games are played, not the UTC date the runner happens to be on.
 */
export function settlementDeadline(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new DeadlineError(`Slate date must be YYYY-MM-DD: "${date}"`);
  const [, y, mo, d] = m;
  // Build the JST wall-clock instant by constructing it in UTC and stepping
  // back the offset — avoids depending on the runner's local timezone, which
  // on GitHub Actions is UTC and on a laptop is not.
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    SETTLEMENT_DEADLINE_JST.hour,
    SETTLEMENT_DEADLINE_JST.minute,
  );
  return new Date(asUtc - JST_UTC_OFFSET_MINUTES * 60_000);
}

/** True once the day's results may be settled, analysed and saved. */
export function isSettlementDue(date: string, now: Date): boolean {
  return now.getTime() >= settlementDeadline(date).getTime();
}

/**
 * NPB's customary start times, for a slate whose feed does not carry one.
 *
 * These are a documented fallback, never a silent guess: a caller that uses
 * them should say so, because a wrong start time moves the lock deadline and
 * can freeze a pick too early or too late.
 */
export const NPB_DEFAULT_STARTS_JST = {
  night: { hour: 18, minute: 0 },
  /** Day games run 12:00–15:00; the earliest is the safe assumption. */
  dayEarliest: { hour: 12, minute: 0 },
  dayLatest: { hour: 15, minute: 0 },
} as const;

/** Compose a JST wall-clock time on a slate date into an absolute instant. */
export function jstInstant(
  date: string,
  time: { hour: number; minute: number },
): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new DeadlineError(`Slate date must be YYYY-MM-DD: "${date}"`);
  const [, y, mo, d] = m;
  return new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), time.hour, time.minute) -
      JST_UTC_OFFSET_MINUTES * 60_000,
  );
}
