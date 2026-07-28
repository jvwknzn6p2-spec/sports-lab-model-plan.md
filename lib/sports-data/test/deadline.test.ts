import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DeadlineError,
  isPredictionLocked,
  isResultsDue,
  jstDateOf,
  jstInstant,
  minutesUntilPredictionLock,
  PREDICTION_DEADLINE_JST,
  predictionDeadline,
  RESULTS_DEADLINE_JST,
  resultsDeadline,
} from "../src/engine/deadline";

/**
 * The slate date is MLB's own game date. Those games run overnight in UTC, so
 * in JST they land the following morning — which is why the "evening before"
 * deadline sits on the slate date itself and the results deadline on the day
 * after.
 */
const SLATE = "2024-07-25";

test("predictions freeze at 22:21 JST on the slate date", () => {
  assert.deepEqual(PREDICTION_DEADLINE_JST, { hour: 22, minute: 21 });
  // 22:21 JST = 13:21 UTC the same calendar day.
  assert.equal(
    predictionDeadline(SLATE).toISOString(),
    "2024-07-25T13:21:00.000Z",
  );
});

test("that deadline really does land before the day's first pitch", () => {
  // The earliest MLB start is around 13:05 ET = 17:05 UTC on the slate date.
  const earliestFirstPitch = new Date("2024-07-25T17:05:00.000Z");
  assert.ok(
    predictionDeadline(SLATE).getTime() < earliestFirstPitch.getTime(),
    "predictions must be committed before any game starts",
  );
});

test("results are due at 16:00 JST on the day AFTER the slate date", () => {
  assert.deepEqual(RESULTS_DEADLINE_JST, { hour: 16, minute: 0 });
  // 16:00 JST on 07-26 = 07:00 UTC on 07-26.
  assert.equal(
    resultsDeadline(SLATE).toISOString(),
    "2024-07-26T07:00:00.000Z",
  );
});

test("that deadline really does land after the last game finishes", () => {
  // A 22:10 ET start (02:10 UTC) runs to roughly 05:30-06:00 UTC.
  const latestFinish = new Date("2024-07-26T06:00:00.000Z");
  assert.ok(
    resultsDeadline(SLATE).getTime() > latestFinish.getTime(),
    "settlement must wait for every game to be final",
  );
});

test("the two deadlines are ordered and about 17.6 hours apart", () => {
  const gap =
    resultsDeadline(SLATE).getTime() - predictionDeadline(SLATE).getTime();
  assert.ok(gap > 0, "predict before settle");
  assert.equal(gap / 3_600_000, 17.65);
});

test("locking flips exactly at the deadline", () => {
  const due = predictionDeadline(SLATE);
  assert.equal(
    isPredictionLocked(SLATE, new Date(due.getTime() - 60_000)),
    false,
  );
  assert.equal(isPredictionLocked(SLATE, due), true, "inclusive");
});

test("results become due exactly at the deadline", () => {
  const due = resultsDeadline(SLATE);
  assert.equal(isResultsDue(SLATE, new Date(due.getTime() - 60_000)), false);
  assert.equal(isResultsDue(SLATE, due), true, "inclusive");
});

test("minutesUntilPredictionLock counts down and then goes negative", () => {
  const oneHourBefore = new Date(
    predictionDeadline(SLATE).getTime() - 60 * 60_000,
  );
  assert.equal(minutesUntilPredictionLock(SLATE, oneHourBefore), 60);
  assert.equal(minutesUntilPredictionLock(SLATE, predictionDeadline(SLATE)), 0);
  assert.ok(minutesUntilPredictionLock(SLATE, resultsDeadline(SLATE)) < 0);
});

test("deadlines are keyed to JST wall-clock, not the host's timezone", () => {
  // Both sit on a different UTC date than they read in JST, which is exactly
  // where a naive local-date comparison goes a day wrong for a JST user.
  assert.equal(jstDateOf(predictionDeadline(SLATE)), "2024-07-25");
  assert.equal(
    predictionDeadline(SLATE).toISOString().slice(0, 10),
    "2024-07-25",
  );
  assert.equal(jstDateOf(resultsDeadline(SLATE)), "2024-07-26");
  // 16:00 JST is 07:00 UTC — same date here, but the JST date is what drives it.
  assert.equal(resultsDeadline(SLATE).toISOString().slice(0, 10), "2024-07-26");
});

test("month and year boundaries roll over correctly", () => {
  assert.equal(
    resultsDeadline("2024-07-31").toISOString(),
    "2024-08-01T07:00:00.000Z",
  );
  assert.equal(
    resultsDeadline("2024-12-31").toISOString(),
    "2025-01-01T07:00:00.000Z",
  );
  // Leap day.
  assert.equal(
    resultsDeadline("2024-02-28").toISOString(),
    "2024-02-29T07:00:00.000Z",
  );
});

test("unreadable dates throw rather than defaulting to today", () => {
  for (const bad of ["2024/07/25", "25-07-2024", "", "tomorrow"]) {
    assert.throws(() => predictionDeadline(bad), DeadlineError, bad);
    assert.throws(() => resultsDeadline(bad), DeadlineError, bad);
  }
  assert.throws(
    () => jstInstant("nope", { hour: 12, minute: 0 }),
    DeadlineError,
  );
});
