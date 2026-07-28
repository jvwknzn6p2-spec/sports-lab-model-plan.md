import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DeadlineError,
  isFinalized,
  isSettlementDue,
  jstInstant,
  LOCK_MINUTES_BEFORE_START,
  lockDeadline,
  minutesUntilLock,
  NPB_DEFAULT_STARTS_JST,
  settlementDeadline,
} from "../src/engine/deadline";

/** 18:00 JST on 2024-07-25 — a standard NPB nighter. */
const NIGHT_START = jstInstant("2024-07-25", NPB_DEFAULT_STARTS_JST.night);
/** 12:00 JST — the earliest NPB day game. */
const DAY_START = jstInstant("2024-07-25", NPB_DEFAULT_STARTS_JST.dayEarliest);

test("an NPB pick freezes 39 minutes before its own first pitch", () => {
  assert.equal(LOCK_MINUTES_BEFORE_START.NPB, 39);
  const d = lockDeadline(NIGHT_START, "NPB")!;
  assert.equal(NIGHT_START.getTime() - d.getTime(), 39 * 60_000);
  // 18:00 JST → 17:21 JST.
  assert.equal(d.toISOString(), "2024-07-25T08:21:00.000Z");
});

test("MLB has no cut-off, so an MLB pick is never frozen automatically", () => {
  // This repository is MLB-first and no MLB rule has been given. Borrowing
  // NPB's number would freeze MLB picks under a rule nobody asked for.
  assert.equal(LOCK_MINUTES_BEFORE_START.MLB, null);
  assert.equal(lockDeadline(NIGHT_START, "MLB"), null);
  assert.equal(isFinalized(NIGHT_START, new Date("2030-01-01"), "MLB"), false);
  assert.equal(minutesUntilLock(NIGHT_START, new Date(), "MLB"), null);
  // MLB is also the default, so an unqualified call cannot freeze anything.
  assert.equal(lockDeadline(NIGHT_START), null);
});

test("the offset is uniform but the deadline is per game", () => {
  // Same 39 minutes for day games and nighters; different absolute cut-offs
  // because each is measured from its own first pitch. 12:00 → 11:21 JST.
  assert.equal(
    lockDeadline(DAY_START, "NPB")!.toISOString(),
    "2024-07-25T02:21:00.000Z",
  );
  assert.equal(
    NIGHT_START.getTime() - lockDeadline(NIGHT_START, "NPB")!.getTime(),
    DAY_START.getTime() - lockDeadline(DAY_START, "NPB")!.getTime(),
    "identical offset",
  );
  assert.notEqual(
    lockDeadline(DAY_START, "NPB")!.getTime(),
    lockDeadline(NIGHT_START, "NPB")!.getTime(),
    "different moments",
  );
});

test("finalization flips at the deadline, not at first pitch", () => {
  const deadline = lockDeadline(NIGHT_START, "NPB")!;
  const oneMinuteBefore = new Date(deadline.getTime() - 60_000);
  const atDeadline = new Date(deadline.getTime());
  assert.equal(isFinalized(NIGHT_START, oneMinuteBefore, "NPB"), false);
  assert.equal(isFinalized(NIGHT_START, atDeadline, "NPB"), true, "inclusive");
  // Still final well after first pitch, obviously.
  assert.equal(
    isFinalized(
      NIGHT_START,
      new Date(NIGHT_START.getTime() + 3_600_000),
      "NPB",
    ),
    true,
  );
});

test("minutesUntilLock counts down and then goes negative", () => {
  const t = new Date(NIGHT_START.getTime() - 60 * 60_000); // 17:00 JST
  assert.equal(minutesUntilLock(NIGHT_START, t, "NPB"), 21);
  assert.equal(minutesUntilLock(NIGHT_START, NIGHT_START, "NPB"), -39);
});

test("a mid-afternoon re-run leaves the day game frozen but the nighter open", () => {
  const at15 = jstInstant("2024-07-25", { hour: 15, minute: 0 });
  assert.equal(
    isFinalized(DAY_START, at15, "NPB"),
    true,
    "12:00 game is committed",
  );
  assert.equal(
    isFinalized(NIGHT_START, at15, "NPB"),
    false,
    "18:00 game still open",
  );
});

test("settlement is due at 23:13 JST on the slate's own date", () => {
  const due = settlementDeadline("2024-07-25");
  // 23:13 JST = 14:13 UTC the same day.
  assert.equal(due.toISOString(), "2024-07-25T14:13:00.000Z");
  const oneMinuteBefore = new Date(due.getTime() - 60_000);
  assert.equal(isSettlementDue("2024-07-25", oneMinuteBefore), false);
  assert.equal(isSettlementDue("2024-07-25", due), true);
});

test("settlement is keyed to the JST slate date, not the runner's UTC date", () => {
  // A runner sitting at 23:20 JST is still on the PREVIOUS UTC date (14:20Z),
  // so a naive UTC-date comparison would call settlement early or late.
  const at2320Jst = jstInstant("2024-07-25", { hour: 23, minute: 20 });
  assert.equal(at2320Jst.toISOString(), "2024-07-25T14:20:00.000Z");
  assert.equal(isSettlementDue("2024-07-25", at2320Jst), true);
  // The next day's slate is of course not due yet.
  assert.equal(isSettlementDue("2024-07-26", at2320Jst), false);
});

test("NPB start-time defaults match the stated schedule", () => {
  assert.deepEqual(NPB_DEFAULT_STARTS_JST.night, { hour: 18, minute: 0 });
  assert.deepEqual(NPB_DEFAULT_STARTS_JST.dayEarliest, { hour: 12, minute: 0 });
  assert.deepEqual(NPB_DEFAULT_STARTS_JST.dayLatest, { hour: 15, minute: 0 });
});

test("unreadable dates and start times throw rather than defaulting", () => {
  assert.throws(() => lockDeadline("not-a-time", "NPB"), DeadlineError);
  assert.throws(() => settlementDeadline("2024/07/25"), DeadlineError);
  assert.throws(
    () => jstInstant("25-07-2024", { hour: 18, minute: 0 }),
    DeadlineError,
  );
});
