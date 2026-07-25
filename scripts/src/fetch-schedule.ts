/**
 * The daily schedule fetch (model-plan.md §5 step 1).
 *
 * ```
 * pnpm --filter @workspace/scripts run fetch-schedule
 * pnpm --filter @workspace/scripts run fetch-schedule -- --date 2026-07-25
 * pnpm --filter @workspace/scripts run fetch-schedule -- --from 2026-04-01 --to 2026-04-30
 * ```
 *
 * Every run writes a timestamped snapshot rather than overwriting the last one,
 * so the morning pull and an evening refresh both survive. That is what makes
 * it possible to see later what was actually known at prediction time.
 */

import { fetchSchedule, fetchScheduleRange, MlbApiError } from "@workspace/mlb-stats";
import type { ScheduledGame, ScheduleSnapshot } from "@workspace/mlb-stats";
import { SnapshotStore } from "@workspace/snapshot-store";

interface Args {
  date: string | null;
  from: string | null;
  to: string | null;
  dataDir: string;
  quiet: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    date: null,
    from: null,
    to: null,
    dataDir: process.env.SPORTS_LAB_DATA_DIR ?? "data",
    quiet: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--date":
        args.date = value;
        i++;
        break;
      case "--from":
        args.from = value;
        i++;
        break;
      case "--to":
        args.to = value;
        i++;
        break;
      case "--data-dir":
        args.dataDir = value;
        i++;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Fetch the MLB schedule and store a timestamped snapshot.",
            "",
            "  --date YYYY-MM-DD     Single date (default: today, US Eastern)",
            "  --from / --to         Inclusive date range, for backfill",
            "  --data-dir DIR        Snapshot root (default: ./data, or $SPORTS_LAB_DATA_DIR)",
            "  --dry-run             Fetch and print, write nothing",
            "  --quiet               Only print the summary line",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (flag.startsWith("--")) {
          console.error(`Unknown flag: ${flag}`);
          process.exit(2);
        }
    }
  }
  return args;
}

/**
 * Today's date in US Eastern time.
 *
 * MLB's `officialDate` follows the league's own calendar, not the machine's. A
 * server running in UTC or JST asking for "today" would ask for tomorrow's
 * games all evening — for a Japanese user this is the difference between
 * getting the slate and getting an empty list.
 */
function todayInBaseballTime(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

const pad = (value: string, width: number): string => value.padEnd(width);

function describeGame(game: ScheduledGame): string {
  const time = new Date(game.startTime).toISOString().slice(11, 16);
  const matchup = `${game.away.name} @ ${game.home.name}`;
  const starters = `${game.away.probablePitcher?.fullName ?? "TBD"} vs ${game.home.probablePitcher?.fullName ?? "TBD"}`;
  const marker = game.isPredictable ? " " : "-";
  const flags = game.flags.length > 0 ? `  [${game.flags.join(", ")}]` : "";
  return `${marker} ${time}Z  ${pad(matchup, 46)} ${pad(starters, 42)}${flags}`;
}

function report(snapshot: ScheduleSnapshot, args: Args): void {
  if (!args.quiet) {
    console.log(`\n${snapshot.date} — ${snapshot.counts.total} games`);
    if (snapshot.games.length > 0) console.log("-".repeat(110));
    for (const game of snapshot.games) console.log(describeGame(game));
  }

  const { total, predictable, postponed, missingPitchers } = snapshot.counts;
  console.log(
    `\n${snapshot.date}: ${total} games · ${predictable} predictable · ` +
      `${postponed} postponed · ${missingPitchers} missing a starter`,
  );

  // Surfaced rather than buried: an unannounced starter is the single most
  // consequential gap in the inputs, and it is normal early in the day.
  if (missingPitchers > 0 && !args.quiet) {
    console.log(
      `  note: ${missingPitchers} game(s) have no announced starter yet — ` +
        "these will be low-confidence until a later refresh.",
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new SnapshotStore(args.dataDir);
  const capturedAt = new Date().toISOString();

  let snapshots: ScheduleSnapshot[];
  try {
    if (args.from || args.to) {
      if (!args.from || !args.to) {
        console.error("--from and --to must be used together");
        process.exit(2);
      }
      snapshots = await fetchScheduleRange(args.from, args.to);
    } else {
      snapshots = [await fetchSchedule(args.date ?? todayInBaseballTime())];
    }
  } catch (error) {
    if (error instanceof MlbApiError) {
      // Distinguish "MLB is down" from "we asked the wrong question" — the
      // first is worth retrying tomorrow, the second is a bug.
      console.error(`\nSchedule fetch failed (${error.kind}) after ${error.attempts} attempt(s).`);
      console.error(`  ${error.message}`);
      console.error(`  url: ${error.url}`);
      process.exit(1);
    }
    throw error;
  }

  let written = 0;
  for (const snapshot of snapshots) {
    report(snapshot, args);
    if (!args.dryRun) {
      const path = await store.write("schedule", snapshot.date, snapshot, capturedAt);
      written++;
      if (!args.quiet) console.log(`  stored: ${path}`);
    }
  }

  const games = snapshots.reduce((sum, snapshot) => sum + snapshot.counts.total, 0);
  const predictable = snapshots.reduce((sum, snapshot) => sum + snapshot.counts.predictable, 0);
  console.log(
    args.dryRun
      ? `\nDry run: ${games} games across ${snapshots.length} date(s), nothing written.`
      : `\nStored ${written} snapshot(s): ${games} games, ${predictable} predictable.`,
  );
}

await main();
