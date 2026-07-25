import { fileURLToPath } from "node:url";
import { argv, env, exit, stderr, stdout } from "node:process";
import { DailyScheduleStore } from "../schedule/store";
import { assembleGameStats } from "../stats/assemble";
import { checkGameStatsSanity } from "../stats/sanity";
import { GameStatsStore } from "../stats/store";

/**
 * Step-2 daily workflow entry point: for a date whose schedule is already
 * cached (see fetch-schedule), assemble core game data — starters, team
 * batting, bullpen/team pitching — for each game, run sanity checks, and cache
 * the bundles.
 *
 * Usage:
 *   node src/cli/fetch-game-stats.ts [YYYY-MM-DD] [--season YYYY] [--out <dir>]
 *
 * Requires the schedule to have been fetched first and outbound access to
 * statsapi.mlb.com. Fails loudly if the schedule is missing.
 */
export interface FetchGameStatsCliArgs {
  date: string;
  season: string;
  outDir: string;
}

export function parseCliArgs(rawArgs: string[], today: string): FetchGameStatsCliArgs {
  let date = today;
  let season: string | undefined;
  let outDir = "./data";
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--out") {
      const next = rawArgs[i + 1];
      if (!next) throw new Error("--out requires a directory argument");
      outDir = next;
      i++;
    } else if (arg === "--season") {
      const next = rawArgs[i + 1];
      if (!next || !/^\d{4}$/.test(next)) throw new Error("--season requires a YYYY year");
      season = next;
      i++;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      date = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return { date, season: season ?? date.slice(0, 4), outDir };
}

export async function runFetchGameStatsCli(rawArgs: string[]): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { date, season, outDir } = parseCliArgs(rawArgs, today);

  const schedule = await new DailyScheduleStore(outDir).load(date);
  if (!schedule) {
    throw new Error(
      `No cached schedule for ${date} in ${outDir}. Run fetch-schedule ${date} first.`,
    );
  }

  stdout.write(
    `Assembling stats for ${schedule.games.length} game(s) on ${date} (season ${season}) ...\n`,
  );

  const store = new GameStatsStore(outDir);
  let sanityIssues = 0;
  for (const game of schedule.games) {
    const bundle = await assembleGameStats(game, { season });
    await store.save(bundle);
    const issues = checkGameStatsSanity(bundle);
    sanityIssues += issues.length;
    const label = `${bundle.away.teamName} @ ${bundle.home.teamName}`;
    stdout.write(
      `  ${label}: ${bundle.dataFlags.length} flag(s)` +
        (issues.length ? `, ${issues.length} sanity issue(s): ${issues.join("; ")}` : "") +
        "\n",
    );
  }

  stdout.write(
    `Cached ${schedule.games.length} bundle(s) to ${outDir}/stats` +
      (sanityIssues ? ` (${sanityIssues} sanity issue(s) total)\n` : "\n"),
  );
  return 0;
}

const isMain = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1];

if (isMain) {
  runFetchGameStatsCli(argv.slice(2))
    .then((code) => exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`fetch-game-stats failed: ${message}\n`);
      if (env["DEBUG"]) stderr.write(`${String(err instanceof Error ? err.stack : err)}\n`);
      exit(1);
    });
}
