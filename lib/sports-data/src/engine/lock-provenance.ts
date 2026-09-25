/**
 * Lock provenance — WHEN each pick was fixed, relative to its deadline and to
 * its game's first pitch, and therefore which record it may count toward.
 *
 * The standing audit (S-4) already measures how late a slate locked, but the
 * cumulative record never used that: every settled pick counted the same,
 * whether it was fixed before the market closed, after the market closed, or
 * after the game had started. A git-history reconstruction on 2026-09-25
 * (every version of every lock file, 849 games) found
 *
 *   MLB  716 games: 135 fixed before the deadline, 578 after the deadline
 *        but before first pitch, 3 after first pitch;
 *   NPB  133 games: 106 before the deadline, 2 after the deadline but before
 *        first pitch, 25 AFTER FIRST PITCH (weekend day games — the first
 *        predict pass was landing ~05:30 UTC for 05:00 UTC starts).
 *
 * The NPB headline (+1.70u, ROI +7.4%) owed +2.70u to three picks produced
 * after first pitch; the picks fixed before their deadline were −1.00u over
 * 20 stakes. A record that mixes the tiers cannot be trusted, so the report
 * keeps them apart. History is never rewritten — tiers are read from the
 * committed lock files alongside it.
 *
 * Tiers:
 *   on_time         fixed before its own lock deadline — the only tier whose
 *                   handicap P&L was executable (the market closes at the
 *                   deadline) and the verified pre-game record.
 *   late_pre_start  fixed after the deadline but before first pitch — a
 *                   genuine pre-game forecast (accuracy/Brier are fair), but
 *                   its P&L could not have been bet: reference only.
 *   post_start      fixed at or after first pitch — cannot be shown to be a
 *                   pre-game prediction; excluded from every verified figure.
 *   unverified      the evidence to place it is missing (no lock row, no
 *                   timestamps); never counted as verified.
 *
 * How a pick is placed:
 *   - Picks written since 2026-09-25 carry `predictedAt` (stamped once, when
 *     the pick is produced, and carried unchanged through re-locks).
 *   - Older picks: the `[warn] predicted_after_deadline` flag marks a late
 *     pick, and a late pick's production time is the lock's `lockedAt`. That
 *     second fact follows from the freeze rule (a pick first produced after
 *     its deadline can only be produced by the first run containing the game,
 *     and `lockedAt` keeps that run's time once anything is carried) and was
 *     checked against the git history of every lock: 849/849 games agree, and
 *     `lockedAt` matches the reconstructed production time to within 2 s.
 */

import type { GamePrediction } from "./decision";

export type LockTier = "on_time" | "late_pre_start" | "post_start" | "unverified";

export const LOCK_TIERS: readonly LockTier[] = [
  "on_time",
  "late_pre_start",
  "post_start",
  "unverified",
];

/** Stamped by `predict` on a pick produced at or after its lock deadline. */
export const LATE_FLAG = "[warn] predicted_after_deadline";
/** Stamped by `predict` on a pick produced at or after first pitch. */
export const POST_START_FLAG = "[error] predicted_after_first_pitch";

export interface ProvenancePick {
  gamePk: number;
  gameDate: string | null;
  flags: string[];
  lockDeadline?: string | null;
  predictedAt?: string | null;
}

export interface ProvenanceLock {
  lockedAt: string | null;
  predictions: ProvenancePick[];
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Which record one pick may count toward. */
export function pickLockTier(
  p: ProvenancePick,
  lockLockedAt: string | null,
): LockTier {
  const start = ms(p.gameDate);
  const predicted = ms(p.predictedAt);
  if (predicted !== null) {
    const deadline = ms(p.lockDeadline);
    if (deadline === null) return "unverified";
    if (predicted < deadline) return "on_time";
    if (start === null) return "unverified";
    return predicted < start ? "late_pre_start" : "post_start";
  }
  // Legacy pick (no predictedAt): the flag is the evidence of lateness.
  if (p.flags.includes(POST_START_FLAG)) return "post_start";
  if (!p.flags.includes(LATE_FLAG)) return "on_time";
  const producedAt = ms(lockLockedAt);
  if (producedAt === null || start === null) return "unverified";
  return producedAt < start ? "late_pre_start" : "post_start";
}

/** `${date}:${gamePk}` → tier, for every pick of every lock. */
export function lockTierIndex(
  locks: Array<{ date: string; lock: ProvenanceLock }>,
): Map<string, LockTier> {
  const out = new Map<string, LockTier>();
  for (const { date, lock } of locks) {
    for (const p of lock.predictions) {
      out.set(`${date}:${p.gamePk}`, pickLockTier(p, lock.lockedAt));
    }
  }
  return out;
}

/** The tier of a settled game; a game with no lock row is unverified. */
export function tierOf(
  index: Map<string, LockTier>,
  date: string,
  gamePk: number,
): LockTier {
  return index.get(`${date}:${gamePk}`) ?? "unverified";
}

/** One-line human description of each tier, shared by every renderer. */
export const LOCK_TIER_LABEL: Record<LockTier, string> = {
  on_time: "fixed before the deadline (verified pre-game record)",
  late_pre_start:
    "fixed after the deadline, before first pitch (forecast only — the market had closed, P&L is reference)",
  post_start:
    "fixed at/after first pitch (not a pre-game prediction — excluded)",
  unverified: "no lock evidence (excluded)",
};

/**
 * A pick produced at or after its game's first pitch is never a pick. The
 * scheduler has landed NPB's first predict pass after weekend day games had
 * started (25 such picks by 2026-09-25, three of them staked), so `predict`
 * keeps the row — the probabilities stay visible as a diagnostic — but
 * withholds every market: PASS, no handicap or total pick, no stake. Settle
 * then scores nothing for it, and the flag makes the reason explicit.
 */
export function withholdAfterFirstPitch(
  p: GamePrediction,
  producedAt: Date,
): GamePrediction {
  return {
    ...p,
    pass: true,
    predictedWinner: null,
    predictedLoser: null,
    handicap: { ...p.handicap, pick: null, recommendedStake: null },
    total: { ...p.total, pick: null },
    reasons: [
      `NO PICK: produced ${producedAt.toISOString()}, at or after first pitch ` +
        `(${p.gameDate}) — a prediction made once the game had started is ` +
        "not a pre-game prediction",
      ...p.reasons,
    ],
    flags: [...p.flags, POST_START_FLAG],
  };
}

/** True when `at` is at or after the game's scheduled first pitch. */
export function isAfterFirstPitch(
  gameDate: string | null | undefined,
  at: Date,
): boolean {
  const start = ms(gameDate);
  return start !== null && at.getTime() >= start;
}
