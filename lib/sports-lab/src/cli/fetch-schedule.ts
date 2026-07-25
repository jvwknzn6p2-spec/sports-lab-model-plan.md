import { fileURLToPath } from "node:url";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fetchDailySchedule } from "../schedule/fetch";
import { DailyScheduleStore } from "../schedule/store";
import { fetchScheduleRaw } from "../schedule/fetch";
import { parseSchedule } from "../schedule/parse";

/**
 * Step-1 daily workflow entry point: fetch one day's MLB schedule and cache it.
 *
 * Usage:
 *   node src/cli/fetch-schedule.ts [YYYY-MM-DD] [--out <dir>]
 *
 * Defaults: date = today (UTC), out = ./data. Requires outbound access to
 * statsapi.mlb.com; in a locked-down environment this will fail loudly, which
 * is the intended behavior (a bad/blocked pull must not look like an empty
 * slate).
 */
export interface FetchScheduleCliArgs {
  date: string;
  outDir: string;
}

export function parseCliArgs(rawArgs: string[], today: string): FetchScheduleCliArgs {
  let date = today;
  let outDir = "./data";
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--out") {
      const next = rawArgs[i + 1];
      if (!next) {
        throw new Error("--out requires a directory argument");
      }
      outDir = next;
      i++;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      date = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return { date, outDir };
}

export async function runFetchScheduleCli(rawArgs: string[]): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { date, outDir } = parseCliArgs(rawArgs, today);

  stdout.write(`Fetching MLB schedule for ${date} ...\n`);

  // Fetch raw first so we can cache the untouched payload for backtesting,
  // then parse it into the clean domain shape.
  const raw = await fetchScheduleRaw(date);
  const schedule = parseSchedule(raw, { date });

  const store = new DailyScheduleStore(outDir);
  const path = await store.save(schedule, raw);

  const flagged = schedule.games.filter((g) => g.dataFlags.length > 0).length;
  stdout.write(
    `Cached ${schedule.games.length} game(s) to ${path}` +
      (flagged > 0 ? ` (${flagged} with data flags)\n` : "\n"),
  );
  return 0;
}

// Keep an explicit reference so bundlers/typecheckers don't flag the
// convenience wrapper as unused; it is part of the public surface.
export { fetchDailySchedule };

const isMain =
  argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === argv[1];

if (isMain) {
  runFetchScheduleCli(argv.slice(2))
    .then((code) => exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`fetch-schedule failed: ${message}\n`);
      if (env["DEBUG"]) {
        stderr.write(`${String(err instanceof Error ? err.stack : err)}\n`);
      }
      exit(1);
    });
}
