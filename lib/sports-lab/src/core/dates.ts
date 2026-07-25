/**
 * Date helpers. Every date the pipeline stores is a `YYYY-MM-DD` string in the
 * MLB "business date" sense — the date the schedule endpoint files a game
 * under, which is US Eastern, not UTC. Getting this wrong shifts late West
 * Coast games onto the wrong day, so it is centralised here.
 */

import type { GameDate } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MLB_SCHEDULE_TIME_ZONE = "America/New_York";

export function assertGameDate(value: string): GameDate {
  if (!DATE_RE.test(value)) {
    throw new Error(`Invalid date "${value}": expected YYYY-MM-DD`);
  }
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (
    asDate.getUTCFullYear() !== y ||
    asDate.getUTCMonth() !== m - 1 ||
    asDate.getUTCDate() !== d
  ) {
    throw new Error(`Invalid date "${value}": not a real calendar date`);
  }
  return value;
}

/** Current date in a given IANA time zone, formatted YYYY-MM-DD. */
export function today(timeZone: string = MLB_SCHEDULE_TIME_ZONE, now = new Date()): GameDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return assertGameDate(parts);
}

export function addDays(date: GameDate, days: number): GameDate {
  const [y, m, d] = assertGameDate(date).split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return [
    shifted.getUTCFullYear().toString().padStart(4, "0"),
    (shifted.getUTCMonth() + 1).toString().padStart(2, "0"),
    shifted.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

/** Inclusive list of dates from `from` to `to`. */
export function dateRange(from: GameDate, to: GameDate): GameDate[] {
  assertGameDate(from);
  assertGameDate(to);
  if (from > to) throw new Error(`Empty range: ${from} > ${to}`);
  const dates: GameDate[] = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    if (dates.length > 3660) throw new Error("Refusing a range longer than 10 years");
  }
  return dates;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function hoursSince(iso: string, now = new Date()): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 3_600_000;
}
