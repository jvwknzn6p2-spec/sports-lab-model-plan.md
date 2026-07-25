/**
 * Self-checking test suite. Run with `pnpm --filter @workspace/snapshot-store run test`.
 * Writes to a temporary directory and cleans up after itself.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SnapshotStore, filenameToTimestamp, timestampToFilename } from "./index.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const root = await mkdtemp(path.join(tmpdir(), "snapshot-store-test-"));
const store = new SnapshotStore(root);

const MORNING = "2026-07-25T09:00:00.000Z";
const MIDDAY = "2026-07-25T15:30:00.000Z";
const EVENING = "2026-07-25T21:45:00.000Z";

try {
  // -------------------------------------------------------------------------
  section("Filename encoding");
  // -------------------------------------------------------------------------
  {
    equal(
      "colons and dots are replaced",
      timestampToFilename(MORNING),
      "2026-07-25T09-00-00-000Z.json",
    );
    equal("filenames round-trip", filenameToTimestamp(timestampToFilename(MORNING)), MORNING);
    equal("non-snapshot files are ignored", filenameToTimestamp("notes.txt"), null);
    equal("partial matches are ignored", filenameToTimestamp("2026-07-25.json"), null);
  }

  // -------------------------------------------------------------------------
  section("Writing and reading");
  // -------------------------------------------------------------------------
  {
    const written = await store.write("schedule", "2026-07-25", { games: 15 }, MORNING);
    check("write returns the path", written.endsWith("2026-07-25T09-00-00-000Z.json"), written);
    check("the path is namespaced by kind and date", written.includes(path.join("schedule", "2026-07-25")));

    const read = await store.read<{ games: number }>("schedule", "2026-07-25", MORNING);
    equal("the payload round-trips", read?.data.games, 15);
    equal("the timestamp is preserved", read?.capturedAt, MORNING);
    equal("the kind is preserved", read?.kind, "schedule");

    const missing = await store.read("schedule", "2026-07-25", EVENING);
    equal("a missing version reads as null", missing, null);
    const missingDate = await store.readLatest("schedule", "2026-01-01");
    equal("a missing date reads as null", missingDate, null);
    const missingKind = await store.readLatest("odds", "2026-07-25");
    equal("a missing kind reads as null", missingKind, null);
    equal("listing an unknown kind is empty", (await store.listDates("odds")).length, 0);
  }

  // -------------------------------------------------------------------------
  section("Versioning");
  // -------------------------------------------------------------------------
  {
    // The core behaviour: a second pull on the same day must not destroy the
    // first. Starters get announced and games get postponed between them, and
    // the morning view is the only record of what we knew when we predicted.
    await store.write("schedule", "2026-07-25", { games: 15, starters: 22 }, MIDDAY);
    await store.write("schedule", "2026-07-25", { games: 14, starters: 28 }, EVENING);

    const versions = await store.listVersions("schedule", "2026-07-25");
    equal("all three versions are kept", versions.length, 3);
    check(
      "versions are sorted oldest first",
      versions[0] === MORNING && versions[1] === MIDDAY && versions[2] === EVENING,
      versions.join(" "),
    );

    const latest = await store.readLatest<{ games: number }>("schedule", "2026-07-25");
    equal("readLatest returns the newest", latest?.capturedAt, EVENING);
    equal("the newest payload is correct", latest?.data.games, 14);

    const first = await store.read<{ games: number }>("schedule", "2026-07-25", MORNING);
    equal("the morning snapshot survived", first?.data.games, 15);

    const all = await store.readAll<{ starters: number }>("schedule", "2026-07-25");
    equal("readAll returns every version", all.length, 3);
    check(
      "readAll is ordered oldest first",
      all[0].data.starters === undefined && all[2].data.starters === 28,
    );
  }

  // -------------------------------------------------------------------------
  section("Point-in-time reads (lookahead protection)");
  // -------------------------------------------------------------------------
  {
    // Backtesting must score a prediction against what was known when it was
    // made. Reading the evening snapshot to grade a morning pick would credit
    // the model with information it did not have.
    const atNoon = await store.readAsOf<{ games: number }>(
      "schedule",
      "2026-07-25",
      "2026-07-25T12:00:00.000Z",
    );
    equal("as-of noon returns the morning pull", atNoon?.capturedAt, MORNING);

    const atDusk = await store.readAsOf<{ games: number }>(
      "schedule",
      "2026-07-25",
      "2026-07-25T18:00:00.000Z",
    );
    equal("as-of dusk returns the midday pull", atDusk?.capturedAt, MIDDAY);

    const exact = await store.readAsOf("schedule", "2026-07-25", MIDDAY);
    equal("an exact timestamp is inclusive", exact?.capturedAt, MIDDAY);

    const tooEarly = await store.readAsOf("schedule", "2026-07-25", "2026-07-25T06:00:00.000Z");
    equal("before the first pull there is nothing", tooEarly, null);
  }

  // -------------------------------------------------------------------------
  section("Listing dates");
  // -------------------------------------------------------------------------
  {
    await store.write("schedule", "2026-07-26", { games: 12 }, "2026-07-26T09:00:00.000Z");
    await store.write("schedule", "2026-07-24", { games: 13 }, "2026-07-24T09:00:00.000Z");

    const dates = await store.listDates("schedule");
    equal("every date is listed", dates.length, 3);
    check(
      "dates are sorted oldest first",
      dates[0] === "2026-07-24" && dates[2] === "2026-07-26",
      dates.join(" "),
    );

    // Different kinds must not bleed into each other.
    await store.write("odds", "2026-07-25", { books: 3 }, MORNING);
    equal("kinds are isolated", (await store.listDates("odds")).length, 1);
    equal("the original kind is unaffected", (await store.listDates("schedule")).length, 3);
  }

  // -------------------------------------------------------------------------
  section("Input validation");
  // -------------------------------------------------------------------------
  {
    for (const badDate of ["2026-7-25", "yesterday", "", "2026/07/25"]) {
      let threw = false;
      try {
        await store.write("schedule", badDate, {});
      } catch {
        threw = true;
      }
      check(`date "${badDate}" is rejected`, threw);
    }

    // A `kind` reaching the filesystem must not be able to escape the root.
    for (const badKind of ["../escape", "a/b", "", ".."]) {
      let threw = false;
      try {
        await store.write(badKind, "2026-07-25", {});
      } catch {
        threw = true;
      }
      check(`kind "${badKind}" cannot escape the root`, threw);
    }
  }

  // -------------------------------------------------------------------------
  section("Defaults");
  // -------------------------------------------------------------------------
  {
    const before = new Date().toISOString();
    await store.write("predictions", "2026-07-25", { count: 1 });
    const after = new Date().toISOString();
    const latest = await store.readLatest("predictions", "2026-07-25");
    check(
      "capturedAt defaults to now",
      latest !== null && latest.capturedAt >= before && latest.capturedAt <= after,
      latest?.capturedAt,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${"-".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("All checks passed.");
