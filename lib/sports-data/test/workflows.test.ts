/**
 * The daily automation is configuration, not code, so nothing else here can
 * catch it when it breaks — and both of its failure modes are silent.
 *
 * The day runs in two stages so that real handicap lines can be entered
 * between them (handiedge-slate.yml explains why). That split introduces
 * exactly two ways to lose a day's picks without anyone noticing:
 *
 *   1. predict stops passing --force to fetch-slate. The morning job has
 *      already written the slate, `fetch-slate` refuses to run over one
 *      without --force, and the evening job then fails EVERY day.
 *   2. the two crons drift together, closing the window the split exists to
 *      open, and every slate silently goes back to ハンデなし.
 *
 * Both are one careless edit away and neither shows up in the picks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JST_UTC_OFFSET_MINUTES,
  PREDICTION_DEADLINE_JST,
} from "../src/engine/deadline";
import { NPB_CONFIG } from "../src/engine/league";

const WORKFLOWS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".github",
  "workflows",
);

const read = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8");

/** Minutes past midnight UTC of a `"M H * * *"` daily cron. */
function cronMinuteOfDay(yaml: string): number {
  const m = /cron:\s*"(\d+)\s+(\d+)\s+\*\s+\*\s+\*"/.exec(yaml);
  assert.ok(m, `no daily cron found in:\n${yaml.slice(0, 400)}`);
  return Number(m[2]) * 60 + Number(m[1]);
}

/** Minutes past midnight UTC of EVERY `"M H * * *"` daily cron in the file. */
function allCronMinutesOfDay(yaml: string): number[] {
  const minutes = [
    ...yaml.matchAll(/cron:\s*"(\d+)\s+(\d+)\s+\*\s+\*\s+\*"/g),
  ].map((m) => Number(m[2]) * 60 + Number(m[1]));
  assert.ok(minutes.length > 0, `no daily crons found in:\n${yaml.slice(0, 400)}`);
  return minutes;
}

test("both slate fetches force unconditionally, or a re-run is a hard failure", () => {
  // `fetch-slate` throws on an existing slate without --force. For predict
  // that means failing every day the morning job succeeded; for the morning
  // job itself it means any second run of the same date fails — a retry after
  // a flaky MLB call, or a manual dispatch to prepare tomorrow early. Neither
  // can hurt: an existing control tower is never overwritten, --force or not.
  for (const f of ["handiedge-slate.yml", "handiedge-predict.yml"]) {
    const step = /pnpm run handiedge fetch-slate[^\n]*/.exec(read(f));
    assert.ok(step, `${f} must fetch the slate`);
    assert.match(step[0], /--force/, `${f}: ${step[0]}`);
    // Conditional forcing is the bug this replaced — the flag has to be
    // unconditional, not spliced in from an input.
    assert.doesNotMatch(step[0], /\$FORCE/, `${f}: ${step[0]}`);
  }
});

test("the morning slate lands early enough to leave an editing window", () => {
  const slate = cronMinuteOfDay(read("handiedge-slate.yml"));
  const predict = cronMinuteOfDay(read("handiedge-predict.yml"));
  const windowMinutes = predict - slate;
  assert.ok(
    windowMinutes >= 240,
    `only ${windowMinutes} min to enter handicap lines — the split exists to ` +
      "give a usable window, and anything under four hours is not one",
  );
});

test("the picks still lock well before the deadline, at the OBSERVED delay", () => {
  const predict = cronMinuteOfDay(read("handiedge-predict.yml"));
  const deadlineUtc =
    PREDICTION_DEADLINE_JST.hour * 60 +
    PREDICTION_DEADLINE_JST.minute -
    JST_UTC_OFFSET_MINUTES;
  // GitHub's scheduler has fired this repository's crons 46–50 minutes late
  // routinely and 117 minutes late once (2026-08-13). Budget for the bad day:
  // a cron that only survives the typical delay is one queue away from
  // stamping a whole slate predicted_after_deadline.
  const OBSERVED_DELAY = 50;
  const headroom = deadlineUtc - (predict + OBSERVED_DELAY);
  assert.ok(
    headroom >= 40,
    `only ${headroom} min of headroom after the observed ${OBSERVED_DELAY} min ` +
      "scheduler delay — move the cron earlier",
  );
  // The safety lock is the lock of last resort, so it must also survive the
  // WORST delay this repository has actually seen — not just the typical one.
  // At the old 12:10 cron the 117-minute spike would have fired 14:07, eight
  // minutes past the deadline, and the "safety" lock would itself have been
  // the late one.
  const WORST_OBSERVED_DELAY = 117;
  const worstCase = deadlineUtc - (predict + WORST_OBSERVED_DELAY);
  assert.ok(
    worstCase > 0,
    `the worst observed scheduler delay (${WORST_OBSERVED_DELAY} min) would ` +
      `fire the safety lock ${-worstCase} min AFTER the deadline — move the cron earlier`,
  );
});

test("nothing that writes data can push at the same time as anything else", () => {
  for (const f of [
    "handiedge-slate.yml",
    "handiedge-predict.yml",
    "handiedge-settle.yml",
  ]) {
    assert.match(
      read(f),
      /concurrency:\s*\n\s*group:\s*handiedge-data/,
      `${f} must serialise against the other data writers`,
    );
  }
});

test("the FIRST NPB predict pass survives the worst observed delay", () => {
  // NPB picks lock per game, 33' before each first pitch — so the earliest
  // deadline a slate can hold is 33' before the earliest standard start
  // (13:00 JST), which is exactly the league's fixed fallback deadline
  // (12:27 JST). A game with that deadline gets its FIRST pick from the
  // earliest predict pass; if that pass fires after 12:27 JST the pick is
  // born late — a genuine discipline breach, not a stale refresh (the
  // 2026-08-23 late_lock: the 02:30 UTC cron fired ~60 min late and the
  // first lock landed 03:30, 3.1 min past a 13:00-JST game's cut-off).
  const earliest = Math.min(...allCronMinutesOfDay(read("npb-predict.yml")));
  const deadlineUtc =
    NPB_CONFIG.deadlines.prediction.hour * 60 +
    NPB_CONFIG.deadlines.prediction.minute -
    JST_UTC_OFFSET_MINUTES;
  const OBSERVED_DELAY = 50;
  const headroom = deadlineUtc - (earliest + OBSERVED_DELAY);
  assert.ok(
    headroom >= 40,
    `only ${headroom} min of headroom after the observed ${OBSERVED_DELAY} min ` +
      "scheduler delay — move the first NPB predict cron earlier",
  );
  const WORST_OBSERVED_DELAY = 117;
  const worstCase = deadlineUtc - (earliest + WORST_OBSERVED_DELAY);
  assert.ok(
    worstCase > 0,
    `the worst observed scheduler delay (${WORST_OBSERVED_DELAY} min) would ` +
      `fire the first NPB pass ${-worstCase} min AFTER the earliest possible ` +
      "per-game deadline — move the cron earlier",
  );
});

test("NPB slate fetches force unconditionally and writers serialise", () => {
  // Same two silent failure modes as MLB: a predict pass that stops forcing
  // fails every day the slate cron ran first, and two NPB writers pushing
  // together lose one of the pushes.
  for (const f of ["npb-slate.yml", "npb-predict.yml"]) {
    const step = /pnpm run handiedge fetch-slate[^\n]*/.exec(read(f));
    assert.ok(step, `${f} must fetch the slate`);
    assert.match(step[0], /--force/, `${f}: ${step[0]}`);
  }
  for (const f of ["npb-slate.yml", "npb-predict.yml", "npb-settle.yml"]) {
    assert.match(
      read(f),
      /concurrency:\s*\n\s*group:\s*handiedge-npb-data/,
      `${f} must serialise against the other NPB data writers`,
    );
  }
});
