#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * The loop, in the order the plan describes it:
 *
 *   predict    Steps 1-7 for a date; writes predictions + report
 *   score      pull final scores for a date and grade what we predicted
 *   analyze    accuracy, calibration and ROI across every graded day
 *   calibrate  refit calibration.json from graded games  (the "improve" step)
 *   loop       score yesterday -> analyze -> calibrate -> predict today
 *   report     re-print a stored day's report without re-predicting
 *   doctor     check config, data directory and source reachability
 *   backtest   predict + score a date range, then analyse it
 */

import { loadRuntimeConfig, MODEL_VERSION, SOURCE_URLS, type RuntimeConfig } from "./config";
import { addDays, assertGameDate, dateRange, today } from "./core/dates";
import type { GameDate, GradedGame } from "./core/types";
import { analyseGraded } from "./loop/analyze";
import { fitCalibration } from "./loop/calibrate";
import { gradeDay, summariseGrading } from "./loop/score";
import { createSources } from "./pipeline/collect";
import { predictDate } from "./pipeline/predict";
import { formatAnalysis, formatDailyReport } from "./report/text";
import { Store } from "./store/store";

interface Args {
  command: string;
  date?: GameDate;
  from?: GameDate;
  to?: GameDate;
  offline: boolean;
  write: boolean;
  json: boolean;
  quiet: boolean;
  sims?: number;
}

function parseArgs(argv: string[]): Args {
  // A leading flag (`--help`, `--date ...`) means no command was given.
  const hasCommand = argv.length > 0 && !argv[0]!.startsWith("-");
  const args: Args = {
    command: hasCommand ? (argv[0] as string) : "help",
    offline: false,
    write: false,
    json: false,
    quiet: false,
  };
  for (let i = hasCommand ? 1 : 0; i < argv.length; i++) {
    const token = argv[i] as string;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} requires a value`);
      return value;
    };
    switch (token) {
      case "--date":
        args.date = assertGameDate(next());
        break;
      case "--from":
        args.from = assertGameDate(next());
        break;
      case "--to":
        args.to = assertGameDate(next());
        break;
      case "--sims":
        args.sims = Number(next());
        break;
      case "--offline":
        args.offline = true;
        break;
      case "--write":
        args.write = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--help":
      case "-h":
        args.command = "help";
        break;
      default:
        throw new Error(`Unknown option "${token}". Run with --help.`);
    }
  }
  return args;
}

function configFor(args: Args): RuntimeConfig {
  const overrides: Partial<RuntimeConfig> = {};
  if (args.offline) overrides.offline = true;
  if (args.sims !== undefined) {
    if (!Number.isFinite(args.sims) || args.sims < 1000) {
      throw new Error("--sims must be at least 1000");
    }
    overrides.simulations = Math.trunc(args.sims);
  }
  return loadRuntimeConfig(overrides);
}

const HELP = `AI Sports Lab ${MODEL_VERSION}

Usage: sports-lab <command> [options]

Commands
  predict     Generate predictions for a date (default: today, US Eastern)
  score       Grade stored predictions for a date against final scores
  analyze     Accuracy / calibration / ROI over every graded day
  calibrate   Refit calibration.json from graded games (add --write to save)
  loop        score yesterday -> analyze -> calibrate -> predict today
  report      Re-print the stored report for a date
  doctor      Environment and source check
  backtest    Predict and score a date range, then analyse it

Options
  --date YYYY-MM-DD    Target date
  --from / --to        Date range (analyze, backtest)
  --sims N             Monte Carlo simulations per game (default 20000)
  --offline            Read fixtures instead of the network
  --write              Persist the result (calibrate)
  --json               Machine-readable output
  --quiet              Suppress the full report body

Environment
  SPORTS_LAB_DATA_DIR  Where predictions/results/calibration are stored
  SPORTS_LAB_SEASON    Season for season-to-date stats (default: current year)
  SPORTS_LAB_SIMS      Default simulation count
  ODDS_API_KEY         The Odds API key. Without it there is no EV and no S/A rank.
`;

async function commandPredict(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  const date = args.date ?? today();
  const calibration = await store.loadCalibration();

  const daily = await predictDate({ date, config, calibration });
  const predictionsFile = await store.savePredictions(daily);
  const report = formatDailyReport(daily);
  const reportFile = await store.saveReport(date, "txt", `${report}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(daily, null, 2)}\n`);
    return 0;
  }
  if (!args.quiet) process.stdout.write(`${report}\n\n`);
  process.stdout.write(
    `${daily.games.length} game(s) predicted, ${daily.skipped.length} skipped.\n` +
      `  predictions -> ${predictionsFile}\n  report      -> ${reportFile}\n`,
  );
  if (calibration.sampleGames === 0) {
    process.stdout.write(
      `\nNote: calibration is unfitted (${calibration.version}), so no game can be ` +
        `ranked S yet. Run \`score\` on finished days, then \`calibrate --write\`.\n`,
    );
  }
  return 0;
}

async function commandScore(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  const date = args.date ?? addDays(today(), -1);

  const predictions = await store.loadPredictions(date);
  if (!predictions) {
    process.stderr.write(
      `No stored predictions for ${date}. Nothing to score — run \`predict --date ${date}\` first.\n`,
    );
    return 1;
  }

  const sources = createSources(config);
  const results = await sources.schedule.results(date);
  await store.saveResults(date, results);

  const graded = gradeDay({ predictions, results });
  const file = await store.saveGraded(graded);
  const summary = summariseGrading(predictions, results, graded);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ summary, graded }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `Scored ${date}: ${summary.graded}/${summary.predicted} predictions graded ` +
      `from ${summary.results} final score(s).\n  graded -> ${file}\n`,
  );
  for (const missing of summary.ungraded) process.stdout.write(`  pending: ${missing}\n`);

  const correct = graded.games.filter((g) => g.moneylineCorrect).length;
  if (graded.games.length > 0) {
    process.stdout.write(
      `  moneyline ${correct}/${graded.games.length} correct on the day.\n`,
    );
  }
  return 0;
}

async function loadGradedRange(
  store: Store,
  from?: GameDate,
  to?: GameDate,
): Promise<{ games: GradedGame[]; from: GameDate; to: GameDate }> {
  const available = await store.gradedDates();
  if (available.length === 0) {
    const fallback = today();
    return { games: [], from: from ?? fallback, to: to ?? fallback };
  }
  const start = from ?? (available[0] as GameDate);
  const end = to ?? (available[available.length - 1] as GameDate);
  const games: GradedGame[] = [];
  for (const date of available) {
    if (date < start || date > end) continue;
    const day = await store.loadGraded(date);
    if (day) games.push(...day.games);
  }
  return { games, from: start, to: end };
}

async function commandAnalyze(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  const { games, from, to } = await loadGradedRange(store, args.from, args.to);
  const report = analyseGraded(games, from, to);
  if (games.length > 0) await store.saveAnalysis(report);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${formatAnalysis(report)}\n`);
  return 0;
}

async function commandCalibrate(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  const previous = await store.loadCalibration();
  const { games, from, to } = await loadGradedRange(store, args.from, args.to);
  const fit = fitCalibration(games, previous, from, to);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(fit, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Calibration fit from ${games.length} graded games (${from} to ${to}).\n`,
    );
    for (const change of fit.changes) process.stdout.write(`  + ${change}\n`);
    for (const skip of fit.skipped) process.stdout.write(`  - ${skip}\n`);
  }

  if (args.write) {
    const file = await store.saveCalibration(fit.calibration);
    process.stdout.write(`  written -> ${file}\n`);
  } else if (!args.json) {
    process.stdout.write("  (dry run — pass --write to save)\n");
  }
  return 0;
}

async function commandLoop(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  const targetDate = args.date ?? today();
  const yesterday = addDays(targetDate, -1);

  process.stdout.write(`=== 1/4  record: scoring ${yesterday} ===\n`);
  const hadPredictions = (await store.loadPredictions(yesterday)) !== null;
  if (hadPredictions) {
    await commandScore({ ...args, date: yesterday, json: false });
  } else {
    process.stdout.write(`  no stored predictions for ${yesterday} — skipping.\n`);
  }

  process.stdout.write(`\n=== 2/4  analyse: every graded day ===\n`);
  const { games, from, to } = await loadGradedRange(store);
  const analysis = analyseGraded(games, from, to);
  if (games.length > 0) {
    await store.saveAnalysis(analysis);
    process.stdout.write(`${formatAnalysis(analysis)}\n`);
  } else {
    process.stdout.write("  nothing graded yet — no accuracy numbers to report.\n");
  }

  process.stdout.write(`\n=== 3/4  improve: refitting calibration ===\n`);
  await commandCalibrate({ ...args, write: true, json: false, from: undefined, to: undefined });

  process.stdout.write(`\n=== 4/4  predict: ${targetDate} ===\n`);
  await commandPredict({ ...args, date: targetDate, json: false });
  return 0;
}

async function commandReport(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  const date = args.date ?? today();
  const stored = await store.loadPredictions(date);
  if (!stored) {
    process.stderr.write(`No stored predictions for ${date}.\n`);
    return 1;
  }
  process.stdout.write(`${formatDailyReport(stored)}\n`);
  return 0;
}

async function commandBacktest(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  if (!args.from || !args.to) {
    process.stderr.write("backtest requires --from and --to.\n");
    return 1;
  }
  process.stdout.write(
    "WARNING: backtesting with this pipeline uses season-to-date stats as they " +
      "stand *now*, not as they stood on the game date. Every prediction below is " +
      "contaminated by look-ahead bias and will look better than a live run. Use it " +
      "to check that the pipeline works end to end, not to estimate profitability.\n\n",
  );

  const calibration = await store.loadCalibration();
  const sources = createSources(config);
  for (const date of dateRange(args.from, args.to)) {
    const daily = await predictDate({ date, config, calibration, sources });
    await store.savePredictions(daily);
    const results = await sources.schedule.results(date);
    await store.saveResults(date, results);
    const graded = gradeDay({ predictions: daily, results });
    await store.saveGraded(graded);
    process.stdout.write(
      `  ${date}: ${daily.games.length} predicted, ${graded.games.length} graded\n`,
    );
  }

  const { games, from, to } = await loadGradedRange(store, args.from, args.to);
  const report = analyseGraded(games, from, to);
  await store.saveAnalysis(report);
  process.stdout.write(`\n${formatAnalysis(report)}\n`);
  return 0;
}

async function commandDoctor(args: Args): Promise<number> {
  const config = configFor(args);
  const store = new Store(config.dataDir);
  const lines: string[] = [];
  let problems = 0;

  lines.push(`model            ${MODEL_VERSION}`);
  lines.push(`season           ${config.season}`);
  lines.push(`simulations      ${config.simulations}`);
  lines.push(`data dir         ${config.dataDir}`);
  lines.push(`offline mode     ${config.offline ? "ON (fixtures only)" : "off"}`);

  const calibration = await store.loadCalibration();
  lines.push(
    `calibration      ${calibration.version} ` +
      `(${calibration.sampleGames} graded games${
        calibration.fittedAt ? `, fitted ${calibration.fittedAt}` : ", never fitted"
      })`,
  );
  if (calibration.sampleGames === 0) {
    lines.push(
      `                 ^ unfitted: probabilities are raw simulation output and no ` +
        `game can be ranked S.`,
    );
  }

  const predictionDates = await store.predictionDates();
  const gradedDates = await store.gradedDates();
  lines.push(
    `history          ${predictionDates.length} day(s) predicted, ` +
      `${gradedDates.length} day(s) graded`,
  );

  if (config.oddsApiKey) {
    lines.push(`odds             key present, book "${config.oddsBook}"`);
  } else {
    lines.push("odds             NO ODDS_API_KEY — no EV, no S/A ranks");
    problems++;
  }

  if (!config.offline) {
    for (const [name, url] of [
      ["MLB Stats API", `${SOURCE_URLS.mlbStatsApi}/teams?sportId=1&season=${config.season}`],
      ["Open-Meteo", `${SOURCE_URLS.openMeteo}?latitude=0&longitude=0&hourly=temperature_2m`],
    ] as const) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (response.ok) {
          lines.push(`${name.padEnd(16)} reachable (HTTP ${response.status})`);
        } else {
          problems++;
          // A 403/407 on a public, keyless endpoint is almost always an egress
          // proxy or network policy rather than the API itself.
          const hint =
            response.status === 403 || response.status === 407
              ? " — likely blocked by a network/egress policy, not by the API"
              : "";
          lines.push(`${name.padEnd(16)} FAILING (HTTP ${response.status})${hint}`);
        }
      } catch (error) {
        lines.push(
          `${name.padEnd(16)} UNREACHABLE — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        problems++;
      }
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(
    problems === 0
      ? "\nAll checks passed.\n"
      : `\n${problems} issue(s) above will limit what the pipeline can produce.\n`,
  );
  return problems === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  switch (args.command) {
    case "predict":
      return commandPredict(args);
    case "score":
      return commandScore(args);
    case "analyze":
    case "analyse":
      return commandAnalyze(args);
    case "calibrate":
      return commandCalibrate(args);
    case "loop":
      return commandLoop(args);
    case "report":
      return commandReport(args);
    case "backtest":
      return commandBacktest(args);
    case "doctor":
      return commandDoctor(args);
    case "help":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${args.command}".\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `\nFailed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
