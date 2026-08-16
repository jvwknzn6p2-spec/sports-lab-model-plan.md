/**
 * The two fixed cut-offs of the daily MLB routine, both stated in JST.
 *
 *   PREDICTION — 22:55 JST the evening before the games.
 *   RESULTS    — 16:00 JST on the day the games finish.
 *
 * ## Why "the evening before" is the slate's own date
 *
 * A slate is keyed by MLB's own calendar date (what statsapi calls the game
 * date). Those games begin around 17:00 UTC and run overnight, so in JST they
 * fall on the FOLLOWING morning: a 2024-07-25 slate is watched in Japan on the
 * 26th. The evening before them is therefore 22:55 JST on the 25th — the slate
 * date itself — and they are all final by 16:00 JST on the 26th, the day after.
 *
 * Concretely, for the 2024-07-25 slate:
 *   prediction  22:55 JST 07-25 = 13:55 UTC — earliest first pitch is 17:05 UTC
 *   results     16:00 JST 07-26 = 07:00 UTC — the last game ends around 06:00 UTC
 *
 * Both conversions are built from UTC arithmetic rather than the host's local
 * timezone, which is UTC on GitHub Actions and something else on a laptop. A
 * naive local-date comparison puts these deadlines a day out for anyone in JST,
 * because 22:55 and 16:00 JST both sit on a different UTC date than they read.
 */

/** Predictions are fixed at this JST time on the evening before the games. */
export const PREDICTION_DEADLINE_JST = { hour: 22, minute: 55 } as const;

/** Results, analysis, learning and saving are due at this JST time. */
export const RESULTS_DEADLINE_JST = { hour: 16, minute: 0 } as const;

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

/**
 * When the slate's predictions stop being editable: 22:55 JST on the slate
 * date, which is the evening before those games are played.
 */
export function predictionDeadline(slateDate: string): Date {
  return jstInstant(slateDate, PREDICTION_DEADLINE_JST);
}

/**
 * When the slate's results are due: 16:00 JST on the day after the slate date,
 * by which point every game of that slate has finished.
 */
export function resultsDeadline(slateDate: string): Date {
  const dayAfter = jstDateOf(
    new Date(jstInstant(slateDate, { hour: 12, minute: 0 }).getTime() + DAY_MS),
  );
  return jstInstant(dayAfter, RESULTS_DEADLINE_JST);
}

/** True once predictions for this slate may no longer change. */
export function isPredictionLocked(slateDate: string, now: Date): boolean {
  return now.getTime() >= predictionDeadline(slateDate).getTime();
}

/** True once the slate's results may be settled, analysed, learned and saved. */
export function isResultsDue(slateDate: string, now: Date): boolean {
  return now.getTime() >= resultsDeadline(slateDate).getTime();
}

/** Minutes until predictions freeze; negative once they have. */
export function minutesUntilPredictionLock(
  slateDate: string,
  now: Date,
): number {
  return Math.round(
    (predictionDeadline(slateDate).getTime() - now.getTime()) / 60_000,
  );
}
