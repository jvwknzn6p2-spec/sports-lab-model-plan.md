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

test("predict refreshes the slate with --force, or it fails every day", () => {
  const yaml = read("handiedge-predict.yml");
  const step = /pnpm run handiedge fetch-slate[^\n]*/.exec(yaml);
  assert.ok(step, "predict must still refresh the slate before locking");
  assert.match(
    step[0],
    /--force/,
    "fetch-slate throws on an existing slate without --force, and the morning " +
      "job writes one every day: " +
      step[0],
  );
  // Conditional forcing is the bug this replaced — the flag has to be
  // unconditional, not spliced in from an input.
  assert.doesNotMatch(step[0], /\$FORCE/, step[0]);
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
