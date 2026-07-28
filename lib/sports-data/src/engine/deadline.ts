/**
 * When a prediction stops being editable.
 *
 * A pick is only honest if it was fixed before the game could inform it. The
 * offset is uniform — the same number of minutes for day games and nighters
 * alike — but the deadline itself is per GAME, because it is measured from
 * each game's own first pitch. A slate with a 12:00 day game and an 18:00
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

/** Leagues that may carry their own cut-off. */
export type LockLeague = "MLB" | "NPB";

/**
 * Minutes before first pitch at which a prediction becomes final.
 *
 * NPB: 39, uniform across day games and nighters — an 18:00 start freezes at
 * 17:21, a 12:00 start at 11:21.
 *
 * MLB: `null`, meaning NO cut-off has been specified. An MLB pick is therefore
 * never frozen automatically. Borrowing NPB's 39 would be inventing a rule for
 * a league whose rule has not been given, and this repository is MLB-first —
 * an unasked-for freeze there is the more damaging error. Set the number here
 * once the MLB cut-off is decided; nothing else has to move.
 */
export const LOCK_MINUTES_BEFORE_START: Record<LockLeague, number | null> = {
  NPB: 39,
  MLB: null,
};

/** This repository's data pipeline is MLB-only, so MLB is the default. */
const DEFAULT_LOCK_LEAGUE: LockLeague = "MLB";

/** Minutes before first pitch for a league, or null when no rule is set. */
export function lockMinutesFor(
  league: LockLeague = DEFAULT_LOCK_LEAGUE,
): number | null {
  return LOCK_MINUTES_BEFORE_START[league];
}

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
 * The moment a game's prediction is frozen: first pitch minus the league's
 * cut-off (39 minutes for NPB). `null` when the league has no rule, which
 * means picks are never frozen automatically.
 */
export function lockDeadline(
  gameStart: string | Date,
  league: LockLeague = DEFAULT_LOCK_LEAGUE,
): Date | null {
  const minutes = lockMinutesFor(league);
  if (minutes === null) return null;
  const start = gameStart instanceof Date ? gameStart : new Date(gameStart);
  if (Number.isNaN(start.getTime())) {
    throw new DeadlineError(`Unreadable game start: ${String(gameStart)}`);
  }
  return new Date(start.getTime() - minutes * 60_000);
}

/** True once the prediction for this game may no longer change. */
export function isFinalized(
  gameStart: string | Date,
  now: Date,
  league: LockLeague = DEFAULT_LOCK_LEAGUE,
): boolean {
  const deadline = lockDeadline(gameStart, league);
  // No rule for this league: nothing is ever frozen behind the owner's back.
  if (deadline === null) return false;
  return now.getTime() >= deadline.getTime();
}

/** Minutes remaining before the pick freezes; negative once it has. */
export function minutesUntilLock(
  gameStart: string | Date,
  now: Date,
  league: LockLeague = DEFAULT_LOCK_LEAGUE,
): number | null {
  const deadline = lockDeadline(gameStart, league);
  if (deadline === null) return null;
  return Math.round((deadline.getTime() - now.getTime()) / 60_000);
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
