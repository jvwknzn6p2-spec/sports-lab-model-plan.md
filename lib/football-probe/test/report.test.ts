import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusReport } from "../src/report";
import { assessRun } from "../src/assess";
import type { RunSummary } from "../src/types";

test("status report lists all 12 items and links evidence to the run dir", () => {
  const summary: RunSummary = {
    runId: "2026-08-30T00-00-00-000Z",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:05.000Z",
    credentials: { sportmonks: false, theOddsApi: false },
    verdicts: assessRun(new Map(), "not attempted (credential not configured)"),
  };
  const md = renderStatusReport(summary, ["SPORTMONKS_API_KEY not set — Sportmonks captures not attempted"]);
  for (const label of [
    "Fixture",
    "Historical results",
    "Teams",
    "Players",
    "Lineups",
    "Formation",
    "Injuries / Suspensions",
    "Match statistics",
    "xG",
    "Odds",
    "Historical Odds",
    "Final Result",
  ]) {
    assert.ok(md.includes(`| ${label} |`), `missing item: ${label}`);
  }
  assert.equal((md.match(/UNVERIFIED/g) ?? []).length >= 12, true);
  assert.ok(md.includes("Sportmonks=no"));
  assert.ok(md.includes("Cambuur vs Twente"));
  assert.ok(md.includes("never taken from documentation"));
});
