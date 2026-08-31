import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CaptureStore } from "./capture";
import { scrubSecrets } from "./redact";
import { probeSportmonks } from "./sportmonks";
import { probeOddsApi } from "./oddsapi";
import { assessRun } from "./assess";
import { renderStatusReport } from "./report";
import type { Capture, RunSummary } from "./types";

// Phase 0 probe entry point. Designed to run on GitHub Actions (the dev
// sandbox has no egress to either provider). Missing credentials are NOT an
// error: the affected items are reported UNVERIFIED and the process exits 0,
// so the workflow stays green while saying honestly that nothing was proven.
//
// Env: SPORTMONKS_API_KEY, ODDS_API_KEY (both optional)
//      FOOTBALL_PROBE_OUT — output root (default probe/football)

async function main(): Promise<void> {
  const outRoot = process.env["FOOTBALL_PROBE_OUT"] ?? "probe/football";
  const smKey = process.env["SPORTMONKS_API_KEY"]?.trim() ?? "";
  const oaKey = process.env["ODDS_API_KEY"]?.trim() ?? "";
  const secrets = [smKey, oaKey].filter((s) => s.length > 0);

  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, "-");
  const runsRoot = join(outRoot, "runs");
  mkdirSync(runsRoot, { recursive: true });
  const store = new CaptureStore(runsRoot, runId, secrets);

  const captures = new Map<string, Capture>();
  const notes: string[] = [];

  if (smKey.length > 0) {
    const r = await probeSportmonks(store, smKey);
    for (const [k, v] of r.captures) captures.set(k, v);
    notes.push(...r.notes);
  } else {
    notes.push("SPORTMONKS_API_KEY not set — Sportmonks captures not attempted");
  }

  if (oaKey.length > 0) {
    const r = await probeOddsApi(store, oaKey);
    for (const [k, v] of r.captures) captures.set(k, v);
    notes.push(...r.notes);
  } else {
    notes.push("ODDS_API_KEY not set — The Odds API captures not attempted");
  }

  // Items end up with zero captures either because a credential was missing
  // or because staged discovery could not resolve the reference-case IDs
  // (e.g. the current subscription cannot see Eredivisie) — say which.
  const noEvidenceReason =
    smKey.length > 0
      ? "not attempted (reference-case discovery failed — see run notes)"
      : "not attempted (credential not configured)";
  const verdicts = assessRun(captures, noEvidenceReason);
  const summary: RunSummary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    credentials: { sportmonks: smKey.length > 0, theOddsApi: oaKey.length > 0 },
    verdicts,
  };

  // The run summary is part of the immutable run directory…
  writeFileSync(join(store.dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  // …while the top-level status report always reflects the latest run.
  writeFileSync(join(outRoot, "phase0-status.md"), renderStatusReport(summary, notes));

  for (const v of verdicts) console.log(`${v.verdict.padEnd(11)} ${v.item}`);
  console.log(`\nrun ${runId}: ${captures.size} capture(s) -> ${store.dir}`);
}

main().catch((err) => {
  // Never print raw error objects that could echo request internals; scrub
  // the message against the credentials before it reaches the log.
  const secrets = [process.env["SPORTMONKS_API_KEY"], process.env["ODDS_API_KEY"]].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const msg = err instanceof Error ? err.message : String(err);
  console.error("probe failed:", scrubSecrets(msg, secrets));
  process.exit(1);
});
