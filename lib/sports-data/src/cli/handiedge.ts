/**
 * HandiEdge — the daily-use MVP CLI.
 *
 *   fetch-slate [--date YYYY-MM-DD] [--season YYYY] [--out <slate.json>] [--force]
 *               [--skip-workloads]
 *     Pull today's schedule + starter/batting/bullpen season stats from the
 *     live MLB Stats API and write data/slates/<date>.json, plus a
 *     control-tower skeleton (data/control-towers/<date>.json) to fill in
 *     handicap lines. Also scans the last 3 days of boxscores to auto-fill
 *     bullpen workloads (fatigue inputs) unless --skip-workloads is passed.
 *     Requires network access to statsapi.mlb.com.
 *
 *   predict --control <control-tower.json> [--slate <slate.json>] [--force]
 *     Control Tower → run model → Monte Carlo → decision engine → calibration
 *     → prediction LOCK (data/predictions/<date>.json) + console report.
 *
 *   fetch-results [--date YYYY-MM-DD] [--out <results.json>] [--force] [--settle]
 *     Pull final scores from the live MLB Stats API (linescore hydrate) and
 *     write data/results/<date>.json. Only Final games are included; live or
 *     postponed games are listed as pending — rerun later with --force.
 *     With --settle, settlement runs immediately after the fetch.
 *
 *   settle --results <results.json>
 *     Settlement → error analysis → self-learning (updates data/calibration.json,
 *     appends data/history.jsonl) + console report.
 *
 *   report
 *     Cumulative accuracy from data/history.jsonl: per-date lines, winner/
 *     handicap/total records, pooled Brier, stated-vs-actual calibration, and
 *     the current self-learning state. Re-settled dates count once (last wins).
 *
 * Control Tower JSON (the single input that controls a run):
 *   {
 *     "date": "2024-07-25", "season": 2024,
 *     "sims": 10000,                          // optional
 *     "passThreshold": 0.55,                  // optional
 *     "minEv": 0,                             // optional: profit per unit a
 *                                             // handicap must clear to be bet
 *     "handicaps": {
 *       // Market notation — the handicap `side` GIVES, as written on the
 *       // slate. This is the normal form: "0", "0.8", "1半", "1半2".
 *       "<gamePk>": { "side": "home", "notation": "1半2", "total": 8.5 },
 *       // Or a signed sportsbook run line, if that is what you have.
 *       "<gamePk>": { "side": "home", "line": -1.5 }
 *     }
 *   }
 *
 * Results JSON:
 *   { "date": "2024-07-25", "results": { "<gamePk>": { "homeScore": 5, "awayScore": 3 } } }
 *
 * Predictions are LOCKED: re-running the same date refuses to overwrite the
 * existing lock unless --force is passed, and the seeded simulator makes the
 * numbers reproducible bit-for-bit.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { distributionCheck, runAudit, type AuditDay } from "../engine/audit";
import {
  walkForward,
  type BacktestDay,
  type SimParams,
} from "../engine/backtest";
import { BacktestDataSource } from "../sources/backtest-source";
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
  fmtPct,
  fmtUnits,
  normalizeCalibration,
  type CalibrationState,
  type GamePrediction,
  type HandicapInput,
} from "../engine/decision";
import {
  settle,
  recalibrateFromHistory,
  type GameResult,
} from "../engine/settle";
import { MlbStatsClient } from "../mlb/client";
import { buildSlate } from "../sources/slate-builder";
import { buildResults } from "../sources/results-builder";
import { buildWorkloads } from "../sources/workload-builder";
import { buildForms, FORM_GAMES_TARGET } from "../sources/form-builder";
import { aggregateHistory } from "../engine/report";
import {
  isPredictionLocked,
  minutesUntilPredictionLock,
  predictionDeadline,
} from "../engine/deadline";
import {
  auditToMarkdown,
  predictionsToMarkdown,
  settlementToMarkdown,
  summaryToMarkdown,
} from "./markdown";
import type { SettlementReport } from "../engine/settle";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..");
const DATA_DIR = join(PKG_ROOT, "data");
const PRED_DIR = join(DATA_DIR, "predictions");
const SLATE_DIR = join(DATA_DIR, "slates");
const CT_DIR = join(DATA_DIR, "control-towers");
const RESULTS_DIR = join(DATA_DIR, "results");
const CALIBRATION_PATH = join(DATA_DIR, "calibration.json");
const HISTORY_PATH = join(DATA_DIR, "history.jsonl");
const REPORTS_DIR = join(DATA_DIR, "reports");
const DEFAULT_SLATE = join(PKG_ROOT, "fixtures", "2024-slate.json");

interface ControlTower {
  date: string;
  season: number;
  sims?: number;
  passThreshold?: number;
  minEv?: number;
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
  return normalizeCalibration(
    await readJson<Partial<CalibrationState>>(CALIBRATION_PATH),
  );
}

async function loadHistory(): Promise<SettlementReport[]> {
  if (!existsSync(HISTORY_PATH)) return [];
  const raw = await readFile(HISTORY_PATH, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SettlementReport);
}

/** Rewrite history with one report per date (a re-settle REPLACES the old one). */
async function saveHistory(reports: SettlementReport[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const body = reports.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(HISTORY_PATH, body, "utf8");
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

/** Write a phone-readable Markdown file (the deliverable for unattended runs). */
async function saveMarkdown(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
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
        `  Handicap: ${p.handicap.pick}  (${pct(p.handicap.coverProbability!)})` +
          (p.handicap.ev === null ? "" : `  EV ${fmtPct(p.handicap.ev)}/unit`),
      );
    } else if (p.handicap.noValue) {
      console.log(
        `  Handicap: no bet at this line  (${pct(p.handicap.coverProbability!)}` +
          `, EV ${fmtPct(p.handicap.ev!)}/unit)`,
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
  "skip-workloads"?: boolean;
  "skip-form"?: boolean;
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

  // Bullpen workloads: relief IP over the last 3 days, from game boxscores.
  // Fail-soft — a gap just means "no fatigue penalty for that team".
  let workloadSummary: string[] = [];
  if (!args["skip-workloads"]) {
    console.log("Scanning last 3 days of boxscores for bullpen usage…");
    const wl = await buildWorkloads({ date, client });
    bundle.workloads = wl.workloads;
    workloadSummary = [
      `  Bullpen usage: ${wl.gamesScanned} boxscore(s) over ${wl.daysScanned.join(", ")}; ` +
        `${Object.keys(wl.workloads).length} team(s) with relief IP tracked.`,
      ...wl.warnings.map((w) => `    - workload: ${w}`),
      `  (unavailableKeyArms stays manual — edit the slate JSON when an arm is down.)`,
    ];
  } else {
    workloadSummary = ["  Bullpen usage scan skipped (--skip-workloads)."];
  }

  // Recent form: last-15-games scoring per slate team (fail-soft).
  if (!args["skip-form"]) {
    console.log("Scanning recent schedules for team form (last 15 games)…");
    const teamIds = bundle.games
      .flatMap((g) => [g.home.teamId, g.away.teamId])
      .filter((id): id is number => id !== null);
    const fm = await buildForms({ date, client, teamIds });
    bundle.forms = fm.forms;
    workloadSummary.push(
      `  Recent form: ${Object.keys(fm.forms).length} team(s) over ` +
        `${fm.daysScanned} day(s) / ${fm.gamesScanned} game(s) (target ${FORM_GAMES_TARGET} finals each).`,
      ...fm.warnings.map((w) => `    - form: ${w}`),
    );
  } else {
    workloadSummary.push("  Recent-form scan skipped (--skip-form).");
  }

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
  for (const line of workloadSummary) console.log(line);
  console.log(`  Slate written → ${outPath}`);

  // Control-tower skeleton: create once, never overwrite the user's edits.
  const ctPath = join(CT_DIR, `${date}.json`);
  if (!existsSync(ctPath)) {
    const handicaps: Record<string, HandicapInput> = {};
    for (const g of bundle.games) {
      // "0" = ハンデなし: a placeholder that is honest about knowing nothing,
      // rather than a -1.5 run line the user never quoted. Replace each with
      // the slate's real handicap, then re-run predict --force.
      handicaps[String(g.gamePk)] = { side: "home", notation: "0" };
    }
    await saveJson(ctPath, {
      date,
      season,
      sims: 10_000,
      passThreshold: 0.55,
      minEv: 0,
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
    ...(ct.minEv !== undefined ? { minEv: ct.minEv } : {}),
  };

  const games = await assembleDate(ct.date, source, { season: ct.season });
  if (games.length === 0) {
    throw new Error(
      `No games for ${ct.date} in slate ${slatePath} — check the date fields match.`,
    );
  }

  // The slate's predictions freeze at 22:55 JST the evening before the games.
  // Once that has passed, a re-run must carry the committed picks through
  // untouched rather than silently rewriting what was already decided.
  const now = new Date();
  const locked = isPredictionLocked(ct.date, now);
  const deadlineIso = predictionDeadline(ct.date).toISOString();
  const previous = existsSync(lockPath)
    ? await readJson<PredictionLock>(lockPath)
    : null;
  const alreadyFinal = new Map<number, GamePrediction>();
  for (const p of previous?.predictions ?? []) {
    if (p.final) alreadyFinal.set(p.gamePk, p);
  }
  if (locked && alreadyFinal.size === 0 && previous) {
    // Deadline passed and an unfrozen lock exists: freeze what is there rather
    // than recomputing it, so the committed slate is what gets settled.
    for (const p of previous.predictions) alreadyFinal.set(p.gamePk, p);
  }

  const predictions: GamePrediction[] = [];
  let carried = 0;
  let lateCount = 0;
  for (const g of games) {
    const kept = alreadyFinal.get(g.gamePk);
    if (kept) {
      predictions.push(kept);
      carried++;
      continue;
    }

    const runs = expectedRuns(g, ct.season);
    const sim = simulateGame(runs.homeMu, runs.awayMu, {
      sims: ct.sims ?? 10_000,
      seed: `${ct.date}:${g.gamePk}`,
    });
    const handicap = ct.handicaps?.[String(g.gamePk)] ?? null;
    const p = decide(g, runs, sim, calibration, handicap, cfg);

    p.lockDeadline = deadlineIso;
    p.final = locked;
    if (locked) {
      // Produced after the slate's cut-off — recorded as such rather than
      // passed off as a pick that was made in time.
      p.flags = [...p.flags, "[warn] predicted_after_deadline"];
      lateCount++;
    }
    predictions.push(p);
  }

  const lock: PredictionLock = {
    lockedAt: new Date().toISOString(),
    controlTower: ct,
    calibration,
    predictions,
  };
  await saveJson(lockPath, lock);
  const mdPath = join(REPORTS_DIR, `${ct.date}.md`);
  await saveMarkdown(
    mdPath,
    predictionsToMarkdown(ct.date, predictions, calibration),
  );

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
  console.log(`Readable report → ${mdPath}`);
  if (carried > 0) {
    console.log(
      `${carried} game(s) were already final and were carried through unchanged.`,
    );
  }
  if (lateCount > 0) {
    console.log(
      `WARNING: ${lateCount} game(s) were predicted after their lock deadline.`,
    );
  }
  const upcoming = predictions
    .filter((p) => !p.final && p.lockDeadline)
    .map((p) =>
      Math.round(
        (new Date(p.lockDeadline!).getTime() - now.getTime()) / 60_000,
      ),
    )
    .sort((a, b) => a - b)[0];
  if (upcoming !== undefined) {
    console.log(`Next pick freezes in ${upcoming} minute(s).`);
  }
}

async function cmdFetchResults(args: {
  date?: string;
  out?: string;
  force?: boolean;
  settle?: boolean;
}): Promise<void> {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD (got "${date}")`);
  }
  const outPath = resolve(args.out ?? join(RESULTS_DIR, `${date}.json`));
  if (existsSync(outPath) && !args.force) {
    throw new Error(
      `Results already exist for ${date} (${outPath}). Use --force to refetch.`,
    );
  }

  console.log(`Fetching MLB final scores for ${date}…`);
  const client = new MlbStatsClient();
  let report;
  try {
    report = await buildResults({ date, client });
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `  Could not reach the MLB Stats API (statsapi.mlb.com). If this ` +
        `environment blocks outbound traffic, run fetch-results from a ` +
        `machine with network access, or write the results JSON by hand ` +
        `and run settle --results.`,
    );
  }

  console.log("=".repeat(72));
  console.log(`HandiEdge — results for ${date}`);
  console.log("=".repeat(72));
  for (const [gamePk, r] of Object.entries(report.results)) {
    console.log(
      `  ${gamePk}: home ${r.homeScore} — away ${r.awayScore}  (Final)`,
    );
  }
  for (const p of report.pending) {
    console.log(`  ${p.gamePk}: ${p.matchup} — PENDING (${p.reason})`);
  }
  if (report.finals === 0) {
    throw new Error(
      `No final games for ${date} yet (${report.pending.length} pending). ` +
        `Nothing written — rerun after the games finish.`,
    );
  }

  const payload = {
    date,
    fetchedAt: new Date().toISOString(),
    results: report.results,
    pending: report.pending,
  };
  await saveJson(outPath, payload);
  console.log(`  Results written → ${outPath}`);
  if (report.pending.length > 0) {
    console.log(
      `  NOTE: ${report.pending.length} game(s) not final — rerun with --force later to include them.`,
    );
  }

  if (args.settle) {
    console.log("");
    await runSettle(payload);
  } else {
    console.log("");
    console.log(`Next: pnpm run handiedge settle --results ${outPath}`);
  }
}

async function cmdSettle(args: { results?: string }): Promise<void> {
  if (!args.results)
    throw new Error("settle requires --results <results.json>");
  const payload = await readJson<{
    date: string;
    results: Record<string, GameResult>;
  }>(resolve(args.results));
  await runSettle(payload);
}

async function runSettle(payload: {
  date: string;
  results: Record<string, GameResult>;
}): Promise<void> {
  const lockPath = join(PRED_DIR, `${payload.date}.json`);
  if (!existsSync(lockPath)) {
    throw new Error(
      `No prediction lock for ${payload.date} (${lockPath}). Run predict first.`,
    );
  }
  const lock = await readJson<PredictionLock>(lockPath);
  const calibration = await loadCalibration();

  const now = new Date();
  const scored = settle(
    payload.date,
    lock.predictions,
    payload.results,
    calibration,
    now,
  );

  // A slate is settled more than once (early pass, then west-coast
  // stragglers). Replace this date's report rather than appending a second
  // one, then relearn from the whole history so the same games are never
  // learned from twice and a corrected re-settle actually corrects the state.
  const history = await loadHistory();
  const merged = [
    ...history.filter((r) => r.date !== scored.date),
    scored,
  ].sort((a, b) => a.date.localeCompare(b.date));
  const relearned = recalibrateFromHistory(merged, DEFAULT_CALIBRATION, now);

  const report = {
    ...scored,
    calibrationBefore: calibration,
    calibrationAfter: relearned,
  };
  await saveHistory(merged.map((r) => (r.date === report.date ? report : r)));
  await saveJson(CALIBRATION_PATH, relearned);
  await saveMarkdown(
    join(REPORTS_DIR, `${report.date}-settled.md`),
    settlementToMarkdown(report),
  );

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
    `  Handicap record: ${report.handicapRecord.wins}-${report.handicapRecord.losses}` +
      (report.handicapProfit === null
        ? ""
        : `  (${fmtUnits(report.handicapProfit)} units after the cut)`),
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
    `  Self-learning:   shrink ${report.calibrationBefore.shrink} → ${report.calibrationAfter.shrink}, ` +
      `tail ${report.calibrationBefore.tailShrink} → ${report.calibrationAfter.tailShrink} ` +
      `(${report.calibrationAfter.gamesSettled} games settled lifetime)`,
  );
  console.log(`  History appended → ${HISTORY_PATH}`);
}

async function cmdReport(): Promise<void> {
  if (!existsSync(HISTORY_PATH)) {
    console.log(
      "No history yet (data/history.jsonl missing). Run settle or " +
        "fetch-results --settle after games finish, then try again.",
    );
    return;
  }
  const s = aggregateHistory(await loadHistory());
  const calibration = await loadCalibration();
  const summaryPath = join(REPORTS_DIR, "summary.md");
  await saveMarkdown(summaryPath, summaryToMarkdown(s, calibration));

  console.log("=".repeat(72));
  console.log(
    `HandiEdge — cumulative results (${s.dates} settled date(s), ` +
      `${s.gamesSettled} pick(s), ${s.gamesPassed} PASS)`,
  );
  console.log("=".repeat(72));
  for (const d of s.perDate) {
    console.log(
      `  ${d.date}: ${d.winnerRecord.wins}-${d.winnerRecord.losses}` +
        ` (${d.settled} pick(s), ${d.passed} PASS` +
        (d.meanBrier === null ? ")" : `, Brier ${d.meanBrier})`),
    );
  }
  console.log("");
  console.log(
    `  Winner:   ${s.winnerRecord.wins}-${s.winnerRecord.losses}` +
      (s.winnerRate === null ? "" : `  (${(s.winnerRate * 100).toFixed(1)}%)`),
  );
  console.log(
    `  Handicap: ${s.handicapRecord.wins}-${s.handicapRecord.losses}` +
      (s.handicapProfitTotal === null
        ? ""
        : `  (${fmtUnits(s.handicapProfitTotal)} units after the cut` +
          (s.handicapRoi === null
            ? ")"
            : `, ROI ${fmtPct(s.handicapRoi)} per bet)`)),
  );
  if (s.handicapProfitAssessment) {
    const p = s.handicapProfitAssessment;
    console.log(
      `  Significance (P&L): ${fmtPct(p.meanProfit)} per bet over ${p.n} stakes — ` +
        `z ${p.z.toFixed(2)}, ` +
        (p.verdict === "ahead"
          ? "statistically ahead of break-even"
          : p.verdict === "behind"
            ? "statistically BEHIND break-even — the book is losing"
            : "not yet distinguishable from luck"),
    );
  }
  if (s.handicapAssessment) {
    const a = s.handicapAssessment;
    console.log(
      `  Hit rate: ${(a.rate * 100).toFixed(1)}% over ${a.n} bets ` +
        `(95% CI ${(a.ci95.lo * 100).toFixed(1)}–${(a.ci95.hi * 100).toFixed(1)}%) ` +
        `vs ${(a.breakEven * 100).toFixed(1)}% full-unit break-even`,
    );
  }
  console.log(`  Total:    ${s.totalRecord.wins}-${s.totalRecord.losses}`);
  if (s.meanBrier !== null) {
    console.log(
      `  Mean Brier: ${s.meanBrier}  (0.25 = coin flip; lower is better)`,
    );
  }
  if (s.statedMean !== null && s.actualRate !== null) {
    const gap = s.actualRate - s.statedMean;
    console.log(
      `  Calibration: stated ${(s.statedMean * 100).toFixed(1)}% vs actual ` +
        `${(s.actualRate * 100).toFixed(1)}%  ` +
        `(${gap >= 0 ? "underconfident" : "overconfident"} by ${Math.abs(gap * 100).toFixed(1)}pt)`,
    );
  }
  if (s.meanMarginError !== null) {
    console.log(`  Mean margin error: ${s.meanMarginError} runs`);
  }
  if (s.meanTotalError !== null) {
    console.log(`  Mean total error:  ${s.meanTotalError} runs`);
  }
  if (s.handicapCalibration) {
    const h = s.handicapCalibration;
    console.log(
      `  Handicap calibration: stated ${(h.statedMean * 100).toFixed(1)}% vs actual ` +
        `${(h.actualRate * 100).toFixed(1)}%  (${h.n} bets, Brier ${h.meanBrier})`,
    );
  }
  if (s.totalCalibration) {
    const t = s.totalCalibration;
    console.log(
      `  Total calibration:    stated ${(t.statedMean * 100).toFixed(1)}% vs actual ` +
        `${(t.actualRate * 100).toFixed(1)}%  (${t.n} bets, Brier ${t.meanBrier})`,
    );
  }
  const bucketLine = (b: (typeof s.handicapBuckets)[number]) =>
    `    ${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%: ` +
    `said ${(b.statedMean * 100).toFixed(1)}%, hit ${(b.actualRate * 100).toFixed(1)}% ` +
    `over ${b.n}  (gap ${(b.gap * 100).toFixed(1)}pt)` +
    (b.flag === "overconfident"
      ? "  ⚠ overconfident band"
      : b.flag === "underconfident"
        ? "  (underconfident)"
        : "");
  if (s.handicapBuckets.length > 0) {
    console.log("  Calibration by band (handicap):");
    for (const b of s.handicapBuckets) console.log(bucketLine(b));
  }
  if (
    s.winnerBuckets.length > 0 &&
    JSON.stringify(s.winnerBuckets) !== JSON.stringify(s.handicapBuckets)
  ) {
    console.log("  Calibration by band (winner):");
    for (const b of s.winnerBuckets) console.log(bucketLine(b));
  }
  if (s.byConfidence.length > 0) {
    console.log("  By confidence:");
    for (const c of s.byConfidence) {
      console.log(
        `    ${c.confidence}: ${c.wins}-${c.losses} ` +
          `(${(c.rate * 100).toFixed(1)}%, ${fmtUnits(c.profit)} units, n=${c.n})`,
      );
    }
  }
  console.log(
    `  Learned shrink (core/tail): moneyline ${calibration.shrink}/${calibration.tailShrink}, ` +
      `handicap ${calibration.handicapShrink}/${calibration.handicapTailShrink}, ` +
      `total ${calibration.totalShrink}/${calibration.totalTailShrink} ` +
      `(${calibration.gamesSettled} games settled lifetime)`,
  );
  if (s.gamesSettled < 30) {
    console.log(
      `  NOTE: ${s.gamesSettled} settled pick(s) is a small sample — judge ` +
        `trends, not single days; ~50+ picks before tuning anything.`,
    );
  }
  console.log(`  Readable summary → ${summaryPath}`);
}

/**
 * audit — the standing audit (checklist items S-3/S-4/A-1/A-4/A-5/B-2).
 *
 * Loads every slate the store knows about, runs the pure checks in
 * engine/audit.ts, prints the findings and writes data/reports/audit.md.
 * Exits non-zero when any error-severity issue is found, so the scheduled
 * workflow goes red instead of quietly committing a report nobody reads.
 */
async function cmdAudit(): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const parseFailures: string[] = [];
  const dates = new Set<string>();
  // Slates and control towers are in the date set on purpose: a day where
  // predict crashed leaves ONLY those files behind, and that is precisely
  // the day the audit must not be blind to.
  for (const dir of [PRED_DIR, RESULTS_DIR, SLATE_DIR, CT_DIR]) {
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (f.endsWith(".json")) dates.add(f.replace(/\.json$/, ""));
    }
  }

  const days: AuditDay[] = [];
  for (const date of [...dates].sort()) {
    const read = async <T>(path: string): Promise<T | null> => {
      if (!existsSync(path)) return null;
      try {
        return await readJson<T>(path);
      } catch {
        // A file that exists but does not parse is itself a finding.
        parseFailures.push(path);
        return null;
      }
    };
    days.push({
      date,
      lock: await read<{ lockedAt: string | null; predictions: GamePrediction[] }>(
        join(PRED_DIR, `${date}.json`),
      ),
      results:
        (
          await read<{ results: Record<string, GameResult> }>(
            join(RESULTS_DIR, `${date}.json`),
          )
        )?.results ?? null,
      controlTowerHandicaps:
        (
          await read<{ handicaps?: Record<string, unknown> }>(
            join(CT_DIR, `${date}.json`),
          )
        )?.handicaps ?? null,
    });
  }

  const history = existsSync(HISTORY_PATH) ? await loadHistory() : [];
  const calibration = await loadCalibration();
  const report = runAudit(days, history, calibration, new Date());
  for (const path of parseFailures) {
    report.issues.push({
      severity: "error",
      code: "unparseable_json",
      detail: `${path} exists but does not parse`,
    });
  }

  await saveMarkdown(join(REPORTS_DIR, "audit.md"), auditToMarkdown(report));

  console.log("=".repeat(72));
  console.log(
    `HandiEdge — standing audit (${report.daysAudited} day(s), ` +
      `${report.issues.length} issue(s))`,
  );
  console.log("=".repeat(72));
  console.log(auditToMarkdown(report));
  console.log(`Report → ${join(REPORTS_DIR, "audit.md")}`);

  // Exit 2 for findings, so callers can tell "the audit worked and found
  // problems" (report is fresh, read it) from "the audit itself crashed"
  // (exit 1 via the main() catch — the report on disk is stale).
  if (report.issues.some((i) => i.severity === "error")) {
    process.exitCode = 2;
  }
}

/**
 * backtest — walk-forward replay over REAL historical seasons.
 *
 *   handiedge backtest --from 2025-04-01 --to 2025-09-28 --season 2025
 *
 * Fetches point-in-time stats from the live MLB API (cached on disk under
 * data/backtest-cache/, git-ignored), replays the production pipeline day by
 * day with walk-forward calibration, and writes the settled history plus a
 * summary — bucket calibration, by-confidence, distribution check — to
 * data/backtest/. No handicap lines are invented: every game runs at the
 * 0-line, so results validate the model, never a market edge.
 */
async function cmdBacktest(args: {
  from?: string;
  to?: string;
  season?: string;
  sims?: string;
  dispersion?: string;
  "env-sd"?: string;
}): Promise<void> {
  if (!args.from || !args.to) {
    throw new Error("backtest requires --from and --to (YYYY-MM-DD)");
  }
  const season = Number(args.season ?? args.from.slice(0, 4));
  const sims = Number(args.sims ?? 10_000);
  // Candidate simulator parameters. Omitted = the production constants, so a
  // plain run IS the production engine; set them to trial a refit against
  // the same real record before touching the defaults.
  const simParams: SimParams = {};
  if (args.dispersion !== undefined) simParams.dispersion = Number(args.dispersion);
  if (args["env-sd"] !== undefined) simParams.envSd = Number(args["env-sd"]);
  const paramTag =
    simParams.dispersion === undefined && simParams.envSd === undefined
      ? ""
      : `_r${simParams.dispersion ?? "prod"}_e${simParams.envSd ?? "prod"}`;
  const cacheDir = join(DATA_DIR, "backtest-cache", String(season));
  const outDir = join(DATA_DIR, "backtest");
  const source = new BacktestDataSource({
    cacheDir,
    season,
    // Stats windows open a wide margin before `from` so early-season days
    // still see their real season-to-date numbers.
    seasonStart: `${season}-03-01`,
  });

  const days: BacktestDay[] = [];
  let skipped = 0;
  for (
    let d = new Date(`${args.from}T00:00:00Z`);
    d.toISOString().slice(0, 10) <= args.to;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const date = d.toISOString().slice(0, 10);
    const schedule = await source.getSchedule(date);
    if (schedule.length === 0) {
      skipped++;
      continue;
    }
    const teamIds = schedule
      .flatMap((g) => [g.home.teamId, g.away.teamId])
      .filter((id): id is number => id !== null);
    await source.setDate(date, [...new Set(teamIds)]);
    const games = await assembleDate(date, source, { season });
    const results = await source.getResults(date);
    days.push({ date, games, results });
    console.log(
      `  ${date}: ${games.length} games, ${Object.keys(results).length} finals`,
    );
  }

  console.log(`Replaying ${days.length} day(s) (${skipped} empty)…`);
  const outcome = walkForward(
    days,
    DEFAULT_CALIBRATION,
    season,
    sims,
    DEFAULT_DECISION_CONFIG,
    simParams,
  );

  // The same aggregations the live report uses, over the replayed history.
  const summary = aggregateHistory(outcome.reports);
  const auditDays: AuditDay[] = days.map((day) => ({
    date: day.date,
    lock: {
      lockedAt: null,
      predictions: outcome.predictions.get(day.date) ?? [],
    },
    results: day.results,
    controlTowerHandicaps: null,
  }));
  // The analytic yardstick must use the SAME parameters the replay drew
  // with, or the distribution check compares apples to oranges.
  const dist = distributionCheck(
    auditDays,
    simParams.dispersion,
    simParams.envSd,
  );

  await mkdir(outDir, { recursive: true });
  // Candidate-parameter runs get their own files — they must never
  // overwrite the production-parameter baseline for the same period.
  const tag = `${args.from}_${args.to}${paramTag}`;
  await writeFile(
    join(outDir, `${tag}.history.jsonl`),
    outcome.reports.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  const md: string[] = [];
  md.push(
    `# Backtest ${args.from} → ${args.to} (season ${season})` +
      (paramTag
        ? ` — candidate params dispersion=${simParams.dispersion ?? "prod"}, envSd=${simParams.envSd ?? "prod"}`
        : ""),
  );
  md.push("");
  md.push(
    `_Walk-forward replay of the production pipeline over the real MLB ` +
      `record. All-zero handicap lines (no historical prices exist — none ` +
      `were invented); bullpen workloads not reconstructed (fatigue ` +
      `penalty absent). Final calibration: moneyline ` +
      `${outcome.calibration.shrink}/${outcome.calibration.tailShrink}, ` +
      `handicap ${outcome.calibration.handicapShrink}/${outcome.calibration.handicapTailShrink} (core/tail)._`,
  );
  md.push("");
  if (dist) {
    md.push("## Distribution check");
    md.push("");
    md.push(
      `- Margin residual variance: empirical ${dist.empiricalMarginVariance} ` +
        `vs model ${dist.modelMarginVariance} over ${dist.n} games`,
    );
    md.push(
      `- Same-game run correlation: empirical ${dist.empiricalRunCorrelation} ` +
        `vs model ${dist.modelRunCorrelation}`,
    );
    md.push(`- Mean |margin error|: ${dist.meanMarginError} runs`);
    md.push("");
  }
  md.push(summaryToMarkdown(summary, outcome.calibration));
  await writeFile(join(outDir, `${tag}-summary.md`), md.join("\n"), "utf8");

  console.log("=".repeat(72));
  console.log(
    `Backtest ${tag}: ${summary.winnerRecord.wins}-${summary.winnerRecord.losses}` +
      (summary.winnerRate === null
        ? ""
        : ` (${(summary.winnerRate * 100).toFixed(1)}%)`) +
      `, ${summary.gamesPassed} PASS`,
  );
  if (summary.handicapProfitAssessment) {
    const p = summary.handicapProfitAssessment;
    console.log(
      `  P&L significance: ${fmtPct(p.meanProfit)}/bet over ${p.n} stakes — z ${p.z.toFixed(2)} (${p.verdict})`,
    );
  }
  if (dist) {
    console.log(
      `  Distribution: var ${dist.empiricalMarginVariance} vs model ${dist.modelMarginVariance}, ` +
        `corr ${dist.empiricalRunCorrelation} vs ${dist.modelRunCorrelation} (n=${dist.n})`,
    );
  }
  console.log(`  Reports → ${outDir}/${tag}-summary.md`);
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
      settle: { type: "boolean", default: false },
      "skip-workloads": { type: "boolean", default: false },
      from: { type: "string" },
      to: { type: "string" },
      sims: { type: "string" },
      dispersion: { type: "string" },
      "env-sd": { type: "string" },
      "skip-form": { type: "boolean", default: false },
    },
  });
  const cmd = positionals[0];
  if (cmd === "fetch-slate") await cmdFetchSlate(values);
  else if (cmd === "fetch-results") await cmdFetchResults(values);
  else if (cmd === "predict") await cmdPredict(values);
  else if (cmd === "settle") await cmdSettle(values);
  else if (cmd === "report") await cmdReport();
  else if (cmd === "audit") await cmdAudit();
  else if (cmd === "backtest") await cmdBacktest(values);
  else {
    console.log("Usage:");
    console.log(
      "  handiedge fetch-slate   [--date YYYY-MM-DD] [--season YYYY] [--out <slate.json>] [--force] [--skip-workloads] [--skip-form]",
    );
    console.log(
      "  handiedge predict       --control <control-tower.json> [--slate <slate.json>] [--force]",
    );
    console.log(
      "  handiedge fetch-results [--date YYYY-MM-DD] [--out <results.json>] [--force] [--settle]",
    );
    console.log("  handiedge settle        --results <results.json>");
    console.log("  handiedge report");
    console.log("  handiedge audit");
    console.log(
      "  handiedge backtest      --from YYYY-MM-DD --to YYYY-MM-DD [--season YYYY] [--sims N] [--dispersion R] [--env-sd S]",
    );
    process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(
    `handiedge failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
