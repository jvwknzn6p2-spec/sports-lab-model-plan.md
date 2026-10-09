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

/**
 * GitHub's scheduler delay on THIS repository, measured 2026-08-24..09-25
 * from each day's first bot commit against its cron: the MLB predict cron
 * landed a median 3.9 h late (p90 5.5 h), the NPB 01:00 pass 4.7 h (p90
 * 5.0 h), the morning slate crons up to 11.5 h. The previous constants
 * (typical 50 min, worst 117 min) were measured in early August and no
 * longer describe the queue: every "safety" lock they blessed landed after
 * its deadline. Re-measure before relaxing these.
 */
const TYPICAL_DELAY = 330; // minutes — the measured p90
const WORST_OBSERVED_DELAY = 690; // minutes — the worst cron seen (11.5 h)

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

test("a predict run is still scheduled well after the morning slate", () => {
  // Lines entered into the control tower after the morning slate are picked
  // up by any later pre-deadline re-lock. The safety lock now runs BEFORE the
  // morning slate (it has to, at the measured delay), so the window is kept
  // by the LATEST predict cron. (No human has edited a control tower to
  // date — every line so far came from the odds fill — but the path stays.)
  const slate = cronMinuteOfDay(read("handiedge-slate.yml"));
  const latest = Math.max(...allCronMinutesOfDay(read("handiedge-predict.yml")));
  assert.ok(
    latest - slate >= 240,
    `only ${latest - slate} min between the morning slate and the last predict cron`,
  );
});

test("the picks still lock well before the deadline, at the OBSERVED delay", () => {
  const predict = Math.min(...allCronMinutesOfDay(read("handiedge-predict.yml")));
  const deadlineUtc =
    PREDICTION_DEADLINE_JST.hour * 60 +
    PREDICTION_DEADLINE_JST.minute -
    JST_UTC_OFFSET_MINUTES;
  // At the typical (p90) delay the earliest lock must land with room to
  // spare — a cron that only survives the median is one queue away from
  // stamping a whole slate predicted_after_deadline.
  const headroom = deadlineUtc - (predict + TYPICAL_DELAY);
  assert.ok(
    headroom >= 40,
    `only ${headroom} min of headroom after the observed ${TYPICAL_DELAY} min ` +
      "scheduler delay — move the cron earlier",
  );
  // The safety lock is the lock of last resort, so it must also survive the
  // WORST delay this repository has actually seen. The 11:40 UTC safety cron
  // this replaced landed ~15:30 UTC on most days of September.
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
  // (12:27 JST = 03:27 UTC). A game with that deadline gets its FIRST pick
  // from the earliest predict pass; if that pass lands after the cut-off the
  // pick is born late, and after first pitch it is not a prediction at all
  // (25 such picks by 2026-09-25, from a 01:00 UTC pass landing ~05:40).
  //
  // The date resolves in JST at run time, so a cron at or after 15:00 UTC
  // (JST midnight) belongs to the NEXT game day: count it from the day before.
  const JST_MIDNIGHT_UTC = 24 * 60 - JST_UTC_OFFSET_MINUTES; // 15:00 UTC
  const earliest = Math.min(
    ...allCronMinutesOfDay(read("npb-predict.yml")).map((m) =>
      m >= JST_MIDNIGHT_UTC ? m - 24 * 60 : m,
    ),
  );
  const deadlineUtc =
    NPB_CONFIG.deadlines.prediction.hour * 60 +
    NPB_CONFIG.deadlines.prediction.minute -
    JST_UTC_OFFSET_MINUTES;
  const headroom = deadlineUtc - (earliest + TYPICAL_DELAY);
  assert.ok(
    headroom >= 40,
    `only ${headroom} min of headroom after the observed ${TYPICAL_DELAY} min ` +
      "scheduler delay — move the first NPB predict cron earlier",
  );
  const worstCase = deadlineUtc - (earliest + WORST_OBSERVED_DELAY);
  assert.ok(
    worstCase > 0,
    `the worst observed scheduler delay (${WORST_OBSERVED_DELAY} min) would ` +
      `fire the first NPB pass ${-worstCase} min AFTER the earliest possible ` +
      "per-game deadline — move the cron earlier",
  );
});

test("no NPB cron lands in the JST evening before its game day", () => {
  // A pass fired between the last game's cut-off and JST midnight resolves
  // TODAY's (already frozen) slate — harmless, but a pass meant for tomorrow
  // must sit at or after 15:00 UTC to resolve tomorrow's date.
  for (const m of allCronMinutesOfDay(read("npb-predict.yml"))) {
    assert.ok(
      m < 9 * 60 || m >= 15 * 60,
      `NPB cron at ${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} UTC ` +
        "resolves neither today's live slate nor tomorrow's",
    );
  }
});

test("a fully frozen slate is not refetched, and is not reviewed again", () => {
  // Refetching after every pick froze overwrote the committed slate that
  // produced the picks (PR #33 could only partially replay 08-27 onwards for
  // exactly this reason), loaded npb.jp and spent odds credits for nothing.
  for (const f of ["handiedge-predict.yml", "npb-predict.yml"]) {
    const y = read(f);
    assert.match(y, /id: frozen/, `${f}: the frozen check is missing`);
    const refresh = /- name: Refresh[^\n]*\n\s+if: ([^\n]+)/.exec(y);
    assert.ok(refresh, `${f}: the slate refresh must be conditional`);
    assert.match(refresh[1]!, /steps\.frozen\.outputs\.frozen != 'true'/, f);
    const review = /- name: AI review \(advisory\)\n\s+if: ([^\n]+)/.exec(y);
    assert.ok(review, `${f}: the AI review step must be conditional`);
    assert.match(review[1]!, /steps\.frozen\.outputs\.frozen != 'true'/, f);
  }
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
