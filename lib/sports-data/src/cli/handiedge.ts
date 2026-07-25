/**
 * HandiEdge — the daily-use MVP CLI.
 *
 *   fetch-slate [--date YYYY-MM-DD] [--season YYYY] [--out <slate.json>] [--force]
 *     Pull today's schedule + starter/batting/bullpen season stats from the
 *     live MLB Stats API and write data/slates/<date>.json, plus a
 *     control-tower skeleton (data/control-towers/<date>.json) to fill in
 *     handicap lines. Requires network access to statsapi.mlb.com.
 *
 *   predict --control <control-tower.json> [--slate <slate.json>] [--force]
 *     Control Tower → run model → Monte Carlo → decision engine → calibration
 *     → prediction LOCK (data/predictions/<date>.json) + console report.
 *
 *   settle --results <results.json>
 *     Settlement → error analysis → self-learning (updates data/calibration.json,
 *     appends data/history.jsonl) + console report.
 *
 * Control Tower JSON (the single input that controls a run):
 *   {
 *     "date": "2024-07-25", "season": 2024,
 *     "sims": 10000,                          // optional
 *     "passThreshold": 0.55,                  // optional
 *     "handicaps": { "<gamePk>": { "side": "home", "line": -1.5, "total": 8.5 } }
 *   }
 *
 * Results JSON:
 *   { "date": "2024-07-25", "results": { "<gamePk>": { "homeScore": 5, "awayScore": 3 } } }
 *
 * Predictions are LOCKED: re-running the same date refuses to overwrite the
 * existing lock unless --force is passed, and the seeded simulator makes the
 * numbers reproducible bit-for-bit.
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { assembleDate } from "../step2";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../sources/fixture-source";
import { expectedRuns } from "../engine/run-model";
import { simulateGame } from "../engine/simulate";
import {
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
  type CalibrationState,
  type GamePrediction,
  type HandicapInput,
} from "../engine/decision";
import { settle, type GameResult } from "../engine/settle";
import { MlbStatsClient } from "../mlb/client";
import { buildSlate } from "../sources/slate-builder";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..");
const DATA_DIR = join(PKG_ROOT, "data");
const PRED_DIR = join(DATA_DIR, "predictions");
const SLATE_DIR = join(DATA_DIR, "slates");
const CT_DIR = join(DATA_DIR, "control-towers");
const CALIBRATION_PATH = join(DATA_DIR, "calibration.json");
const HISTORY_PATH = join(DATA_DIR, "history.jsonl");
const DEFAULT_SLATE = join(PKG_ROOT, "fixtures", "2024-slate.json");

interface ControlTower {
  date: string;
  season: number;
  sims?: number;
  passThreshold?: number;
  handicaps?: Record<string, HandicapInput>;
}

interface PredictionLock {
  lockedAt: string;
  controlTower: ControlTower;
  calibration: CalibrationState;
  predictions: GamePrediction[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadCalibration(): Promise<CalibrationState> {
  if (!existsSync(CALIBRATION_PATH)) return { ...DEFAULT_CALIBRATION };
  return readJson<CalibrationState>(CALIBRATION_PATH);
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

function printPrediction(p: GamePrediction): void {
  console.log("");
  console.log(
    `${p.away} @ ${p.home}   [${p.pass ? "PASS" : `PICK · confidence ${p.confidence}`}]`,
  );
  if (!p.pass) {
    console.log(
      `  Winner:   ${p.predictedWinner}  (${pct(p.winProbability)}; loser: ${p.predictedLoser})`,
    );
    if (p.handicap.pick) {
      console.log(
        `  Handicap: ${p.handicap.pick}  (${pct(p.handicap.coverProbability!)})`,
      );
    }
    if (p.total.pick) {
      console.log(
        `  Total:    ${p.total.pick} ${p.total.line}  (${pct(p.total.probability!)}; model ${p.total.predicted})`,
      );
    }
  } else {
    console.log(
      `  Model lean: ${pct(p.winProbability)} — below threshold or data issue → no bet`,
    );
  }
  console.log(
    `  Expected runs: ${p.home} ${p.expectedRuns.home} — ${p.away} ${p.expectedRuns.away}`,
  );
  console.log(`  Reasons:`);
  for (const r of p.reasons.slice(0, 6)) console.log(`    - ${r}`);
  if (p.flags.length) console.log(`  Flags: ${p.flags.join(", ")}`);
}

async function cmdFetchSlate(args: {
  date?: string;
  season?: string;
  out?: string;
  force?: boolean;
}): Promise<void> {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD (got "${date}")`);
  }
  const season = args.season ? Number(args.season) : Number(date.slice(0, 4));
  const outPath = resolve(args.out ?? join(SLATE_DIR, `${date}.json`));
  if (existsSync(outPath) && !args.force) {
    throw new Error(
      `Slate already exists for ${date} (${outPath}). Use --force to refetch.`,
    );
  }

  console.log(`Fetching MLB slate for ${date} (season ${season})…`);
  const client = new MlbStatsClient();
  let report;
  try {
    report = await buildSlate({ date, season, client });
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `  Could not reach the MLB Stats API (statsapi.mlb.com). If this ` +
        `environment blocks outbound traffic, run fetch-slate from a machine ` +
        `with network access, or pass predict an existing slate via --slate.`,
    );
  }
  const bundle = { ...report.bundle, fetchedAt: new Date().toISOString() };
  await saveJson(outPath, bundle);

  console.log("=".repeat(72));
  console.log(`HandiEdge — slate for ${date}`);
  console.log("=".repeat(72));
  for (const g of bundle.games) {
    const sp = (id: number | null) =>
      id !== null && bundle.starters[String(id)] ? "✓" : "✗";
    console.log(
      `  ${g.gamePk}  ${g.away.teamName ?? "?"} @ ${g.home.teamName ?? "?"}` +
        `  (SP ${g.away.probablePitcherName ?? "TBD"} ${sp(g.away.probablePitcherId)}` +
        ` vs ${g.home.probablePitcherName ?? "TBD"} ${sp(g.home.probablePitcherId)})`,
    );
  }
  console.log(
    `  Starters ${report.startersFetched}/${report.startersExpected}, ` +
      `teams ${report.teamsFetched}/${report.teamsExpected} (batting+bullpen).`,
  );
  if (report.warnings.length) {
    console.log("  Warnings:");
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`  Slate written → ${outPath}`);

  // Control-tower skeleton: create once, never overwrite the user's edits.
  const ctPath = join(CT_DIR, `${date}.json`);
  if (!existsSync(ctPath)) {
    const handicaps: Record<string, HandicapInput> = {};
    for (const g of bundle.games) {
      handicaps[String(g.gamePk)] = { side: "home", line: -1.5 };
    }
    await saveJson(ctPath, {
      date,
      season,
      sims: 10_000,
      passThreshold: 0.55,
      handicaps,
    });
    console.log(
      `  Control-tower skeleton → ${ctPath}  (edit lines/totals, then run predict)`,
    );
  } else {
    console.log(`  Control tower exists → ${ctPath}  (kept your edits)`);
  }
  console.log("");
  console.log(`Next: pnpm run handiedge predict --control ${ctPath}`);
}

async function cmdPredict(args: {
  control?: string;
  slate?: string;
  force?: boolean;
}): Promise<void> {
  if (!args.control)
    throw new Error("predict requires --control <control-tower.json>");
  const ct = await readJson<ControlTower>(resolve(args.control));
  const lockPath = join(PRED_DIR, `${ct.date}.json`);
  if (existsSync(lockPath) && !args.force) {
    throw new Error(
      `Prediction lock already exists for ${ct.date} (${lockPath}). Use --force to re-lock.`,
    );
  }

  // Slate resolution: explicit --slate > today's fetched slate > demo fixture.
  const fetchedSlate = join(SLATE_DIR, `${ct.date}.json`);
  const slatePath = resolve(
    args.slate ?? (existsSync(fetchedSlate) ? fetchedSlate : DEFAULT_SLATE),
  );
  const bundle = await readJson<FixtureBundle>(slatePath);
  const source = new FixtureCoreDataSource(bundle);
  const calibration = await loadCalibration();

  const cfg = {
    ...DEFAULT_DECISION_CONFIG,
    ...(ct.passThreshold !== undefined
      ? { passThreshold: ct.passThreshold }
      : {}),
  };

  const games = await assembleDate(ct.date, source, { season: ct.season });
  if (games.length === 0) {
    throw new Error(
      `No games for ${ct.date} in slate ${slatePath} — check the date fields match.`,
    );
  }

  const predictions: GamePrediction[] = [];
  for (const g of games) {
    const runs = expectedRuns(g, ct.season);
    const sim = simulateGame(runs.homeMu, runs.awayMu, {
      sims: ct.sims ?? 10_000,
      seed: `${ct.date}:${g.gamePk}`,
    });
    const handicap = ct.handicaps?.[String(g.gamePk)] ?? null;
    predictions.push(decide(g, runs, sim, calibration, handicap, cfg));
  }

  const lock: PredictionLock = {
    lockedAt: new Date().toISOString(),
    controlTower: ct,
    calibration,
    predictions,
  };
  await saveJson(lockPath, lock);

  console.log("=".repeat(72));
  console.log(
    `HandiEdge — predictions for ${ct.date}  (calibration shrink ${calibration.shrink})`,
  );
  console.log("=".repeat(72));
  for (const p of predictions) printPrediction(p);
  const picks = predictions.filter((p) => !p.pass);
  console.log("");
  console.log("-".repeat(72));
  console.log(
    `${predictions.length} game(s): ${picks.length} pick(s), ${predictions.length - picks.length} PASS. ` +
      `LOCKED → ${lockPath}`,
  );
}

async function cmdSettle(args: { results?: string }): Promise<void> {
  if (!args.results)
    throw new Error("settle requires --results <results.json>");
  const payload = await readJson<{
    date: string;
    results: Record<string, GameResult>;
  }>(resolve(args.results));
  const lockPath = join(PRED_DIR, `${payload.date}.json`);
  if (!existsSync(lockPath)) {
    throw new Error(
      `No prediction lock for ${payload.date} (${lockPath}). Run predict first.`,
    );
  }
  const lock = await readJson<PredictionLock>(lockPath);
  const calibration = await loadCalibration();

  const report = settle(
    payload.date,
    lock.predictions,
    payload.results,
    calibration,
    new Date(),
  );

  await saveJson(CALIBRATION_PATH, report.calibrationAfter);
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(HISTORY_PATH, JSON.stringify(report) + "\n", "utf8");

  console.log("=".repeat(72));
  console.log(`HandiEdge — settlement for ${report.date}`);
  console.log("=".repeat(72));
  for (const g of report.games) {
    const mark = g.pass ? "PASS" : g.winnerCorrect ? "WIN ✓" : "LOSS ✗";
    console.log(
      `  ${g.away} @ ${g.home}: ${mark}` +
        (g.pass
          ? ""
          : `  (picked ${g.predictedWinner} ${pct(g.statedProbability!)}, actual ${g.actualWinner})`) +
        (g.handicapCorrect === null
          ? ""
          : `  | handicap ${g.handicapCorrect ? "✓" : "✗"} (${g.handicapPick})`) +
        (g.totalCorrect === null
          ? ""
          : `  | total ${g.totalCorrect ? "✓" : "✗"} (${g.totalPick})`),
    );
  }
  console.log("");
  console.log(
    `  Winner record:   ${report.winnerRecord.wins}-${report.winnerRecord.losses}`,
  );
  console.log(
    `  Handicap record: ${report.handicapRecord.wins}-${report.handicapRecord.losses}`,
  );
  console.log(
    `  Total record:    ${report.totalRecord.wins}-${report.totalRecord.losses}`,
  );
  if (report.meanBrier !== null)
    console.log(`  Mean Brier:      ${report.meanBrier}`);
  if (report.statedVsActual) {
    console.log(
      `  Calibration:     stated ${pct(report.statedVsActual.statedMean)} vs actual ${pct(report.statedVsActual.actualRate)}`,
    );
  }
  if (report.meanMarginError !== null)
    console.log(`  Mean margin err: ${report.meanMarginError} runs`);
  if (report.meanTotalError !== null)
    console.log(`  Mean total err:  ${report.meanTotalError} runs`);
  console.log(
    `  Self-learning:   shrink ${report.calibrationBefore.shrink} → ${report.calibrationAfter.shrink} ` +
      `(${report.calibrationAfter.gamesSettled} games settled lifetime)`,
  );
  console.log(`  History appended → ${HISTORY_PATH}`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      control: { type: "string" },
      slate: { type: "string" },
      results: { type: "string" },
      date: { type: "string" },
      season: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const cmd = positionals[0];
  if (cmd === "fetch-slate") await cmdFetchSlate(values);
  else if (cmd === "predict") await cmdPredict(values);
  else if (cmd === "settle") await cmdSettle(values);
  else {
    console.log("Usage:");
    console.log(
      "  handiedge fetch-slate [--date YYYY-MM-DD] [--season YYYY] [--out <slate.json>] [--force]",
    );
    console.log(
      "  handiedge predict --control <control-tower.json> [--slate <slate.json>] [--force]",
    );
    console.log("  handiedge settle  --results <results.json>");
    process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(
    `handiedge failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
