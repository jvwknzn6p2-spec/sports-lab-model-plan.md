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
 *   fetch-results [--date YYYY-MM-DD] [--out <results.json>] [--force] [--settle] [--poll]
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
 *       "<gamePk>": { "side": "home", "line": -1.5 },
 *       // null (the skeleton default) = no line entered yet: the handicap
 *       // market is NOT quoted for this game — moneyline and total only.
 *       // Distinct from "0", which is a deliberate pick'em quote.
 *       "<gamePk>": { "side": "home", "notation": null }
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

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";

import { distributionCheck, runAudit, type AuditDay } from "../engine/audit";
import {
  newRecords,
  reevaluateDate,
  summarizeReevaluations,
  type ReevaluationRecord,
  type RegulationScore,
  type RegulationScoreFile,
} from "../engine/reevaluate";
import { replayLock, sha256, type ReplayOutput } from "../engine/replay";
import { NPB_PRODUCTION_CUTOVER, productionRule, ruleById, ruleTag } from "../engine/settlement-rules";
import { fetchNpbRegulationScores } from "../npb/regulation";
import { fetchNpbPage } from "../npb/slate";
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
import {
  anthropicReviewModel,
  buildReviewPayload,
  REVIEW_MODEL_ID,
  REVIEWER_ROLES,
  reviewToMarkdown,
  runAiReview,
} from "../engine/ai-review";
import { MlbStatsClient } from "../mlb/client";
import { buildSlate } from "../sources/slate-builder";
import {
  fetchMlbOdds,
  fillControlTowerFromOdds,
} from "../sources/odds-source";
import { buildResults } from "../sources/results-builder";
import { buildWorkloads } from "../sources/workload-builder";
import { buildForms, FORM_GAMES_TARGET } from "../sources/form-builder";
import { buildWeather } from "../sources/weather";
import { buildInjuries } from "../sources/injuries-builder";
import {
  aggregateHistory,
  marketRecordLabel,
  TOTAL_MARKET_NEVER_QUOTED,
} from "../engine/report";
import {
  gamePredictionDeadline,
  isPredictionLocked,
  predictionFrozen,
} from "../engine/deadline";
import {
  MLB_CONFIG,
  resolveLeague,
  type LeagueConfig,
} from "../engine/league";
import { registerSeasonConstants } from "../sabermetrics";
import { buildNpbSlate, fetchNpbResults } from "../npb/slate";
import { buildNpbWeather } from "../npb/weather";
import { teamById } from "../npb/teams";
import {
  auditToMarkdown,
  predictionsToMarkdown,
  settlementToMarkdown,
  summaryToMarkdown,
} from "./markdown";
import type { SettlementReport } from "../engine/settle";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..");

/**
 * The active league, set ONCE in main() before any command runs (default
 * MLB). Every path below is derived from it: each league keeps its own
 * slates, locks, results, history and learned calibration — MLB's shrinks
 * were earned on MLB bets and NPB neither reads nor teaches them.
 */
let LEAGUE: LeagueConfig = MLB_CONFIG;
let DATA_DIR = join(PKG_ROOT, MLB_CONFIG.dataDirName);
let PRED_DIR = join(DATA_DIR, "predictions");
let SLATE_DIR = join(DATA_DIR, "slates");
let CT_DIR = join(DATA_DIR, "control-towers");
let RESULTS_DIR = join(DATA_DIR, "results");
let CALIBRATION_PATH = join(DATA_DIR, "calibration.json");
let HISTORY_PATH = join(DATA_DIR, "history.jsonl");
let REPORTS_DIR = join(DATA_DIR, "reports");
let REGULATION_DIR = join(DATA_DIR, "regulation-scores");
let REEVAL_PATH = join(DATA_DIR, "reevaluations.jsonl");
let CALIBRATION_SHADOW_PATH = join(DATA_DIR, "calibration-shadow.json");
const DEFAULT_SLATE = join(PKG_ROOT, "fixtures", "2024-slate.json");

function setLeague(cfg: LeagueConfig): void {
  LEAGUE = cfg;
  DATA_DIR = join(PKG_ROOT, cfg.dataDirName);
  PRED_DIR = join(DATA_DIR, "predictions");
  SLATE_DIR = join(DATA_DIR, "slates");
  CT_DIR = join(DATA_DIR, "control-towers");
  RESULTS_DIR = join(DATA_DIR, "results");
  CALIBRATION_PATH = join(DATA_DIR, "calibration.json");
  HISTORY_PATH = join(DATA_DIR, "history.jsonl");
  REPORTS_DIR = join(DATA_DIR, "reports");
  REGULATION_DIR = join(DATA_DIR, "regulation-scores");
  REEVAL_PATH = join(DATA_DIR, "reevaluations.jsonl");
  CALIBRATION_SHADOW_PATH = join(DATA_DIR, "calibration-shadow.json");
}

/**
 * Point every store path at another league data directory (the replay reads
 * the PR head's committed locks and slates while running the BASE checkout's
 * code — inputs must be identical on both sides, only the code differs).
 */
function setDataDir(dir: string): void {
  DATA_DIR = resolve(dir);
  PRED_DIR = join(DATA_DIR, "predictions");
  SLATE_DIR = join(DATA_DIR, "slates");
  CT_DIR = join(DATA_DIR, "control-towers");
  RESULTS_DIR = join(DATA_DIR, "results");
  CALIBRATION_PATH = join(DATA_DIR, "calibration.json");
  HISTORY_PATH = join(DATA_DIR, "history.jsonl");
  REPORTS_DIR = join(DATA_DIR, "reports");
  REGULATION_DIR = join(DATA_DIR, "regulation-scores");
  REEVAL_PATH = join(DATA_DIR, "reevaluations.jsonl");
  CALIBRATION_SHADOW_PATH = join(DATA_DIR, "calibration-shadow.json");
}

/** The code version stamped on evaluations: the checkout's git commit. */
function codeVersion(): string {
  const fromEnv = process.env["HANDIEDGE_CODE_VERSION"];
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { cwd: PKG_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

interface ControlTower {
  date: string;
  season: number;
  sims?: number;
  passThreshold?: number;
  minEv?: number;
  handicaps?: Record<string, HandicapInput>;
}

interface PredictionLock {
  /**
   * When this slate was FIRST committed — the timestamp the deadline audit
   * (S-4) grades. A re-run that carries the frozen picks through must not
   * move it: the picks were decided when they were decided, and restamping
   * would turn an on-time slate into a late one on the strength of a
   * housekeeping run that changed no pick.
   */
  lockedAt: string;
  /** When the file was last written, whether or not any pick changed. */
  updatedAt?: string;
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

/**
 * Control-tower skeleton + odds fill, shared by the MLB and NPB slate
 * fetches. Create-once (a human's edits are never overwritten), then fill
 * still-unentered lines from The Odds API consensus. `oddsGames` is the
 * games list whose team NAMES match what the odds feed speaks — identical
 * to `games` for MLB; for NPB it carries the English club names.
 */
async function writeSkeletonAndFillOdds(
  date: string,
  season: number,
  games: FixtureBundle["games"],
  oddsGames: FixtureBundle["games"],
): Promise<string> {
  // Control-tower skeleton: create once, never overwrite the user's edits.
  const ctPath = join(CT_DIR, `${date}.json`);
  if (!existsSync(ctPath)) {
    const handicaps: Record<string, HandicapInput> = {};
    for (const g of games) {
      // null = 未入力: no line has been entered yet, so predict quotes NO
      // handicap market for the game (moneyline and total only). This is
      // deliberately not "0" — "0" is a real pick'em quote, and writing it
      // as the placeholder let 24 straight unedited control towers run the
      // moneyline twice under two names. Replace each null with the slate's
      // real handicap, then re-run predict --force.
      handicaps[String(g.gamePk)] = { side: "home", notation: null };
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

  // Market lines: fill any still-unentered handicap/total from The Odds API
  // consensus. Entered lines are never touched, and a fetch failure leaves
  // the tower as it is — the day then simply quotes no handicap market.
  const oddsKey = process.env.ODDS_API_KEY;
  if (oddsKey) {
    try {
      const events = await fetchMlbOdds({
        apiKey: oddsKey,
        sportKey: LEAGUE.oddsSportKey,
      });
      const ct = await readJson<ControlTower>(ctPath);
      const fill = fillControlTowerFromOdds(
        ct.handicaps ?? {},
        oddsGames,
        events,
      );
      await saveJson(ctPath, ct);
      console.log(
        `  Odds: filled ${fill.linesFilled} line(s) and ${fill.totalsFilled} ` +
          `total(s) from market consensus` +
          (fill.kept ? `; kept ${fill.kept} entered line(s)` : ""),
      );
      for (const w of fill.warnings) console.log(`    - ${w}`);
    } catch (err) {
      console.log(
        `  Odds fetch FAILED — lines stay unentered (no handicap market): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.log(
      "  Odds: ODDS_API_KEY not set — enter lines by hand or export a key " +
        "(https://the-odds-api.com) to fill them automatically.",
    );
  }
  return ctPath;
}

/** NPB slate fetch — npb.jp pages instead of statsapi (see src/npb/). */
async function cmdFetchSlateNpb(args: {
  date?: string;
  out?: string;
  force?: boolean;
  "skip-weather"?: boolean;
}): Promise<void> {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD (got "${date}")`);
  }
  const outPath = resolve(args.out ?? join(SLATE_DIR, `${date}.json`));
  if (existsSync(outPath) && !args.force) {
    throw new Error(
      `Slate already exists for ${date} (${outPath}). Use --force to refetch.`,
    );
  }

  console.log(`Fetching NPB slate for ${date} from npb.jp…`);
  const report = await buildNpbSlate({ date });
  const bundle = report.bundle;
  if (bundle.games.length === 0) {
    throw new Error(
      `No NPB games scheduled on ${date} (month page carried ` +
        `${report.monthGameCount} game(s) on other dates).`,
    );
  }

  // First-pitch weather (Open-Meteo, keyless) at the 12 main parks — same
  // fail-soft policy as MLB; a 地方開催 game (venueId null) has no
  // coordinates and simply runs weatherless. NPB wind stays direction-blind
  // (no orientation feed) — see src/npb/weather.ts for the honesty rules.
  if (!args["skip-weather"]) {
    console.log("Fetching first-pitch weather (Open-Meteo)…");
    const wx = await buildNpbWeather({ date, games: bundle.games });
    bundle.weather = wx.weather;
    report.notes.push(
      `Weather: ${Object.keys(wx.weather).length}/${bundle.games.length} game(s) covered.`,
      ...wx.warnings.map((w) => `weather: ${w}`),
    );
  } else {
    report.notes.push("Weather fetch skipped (--skip-weather).");
  }

  await saveJson(outPath, bundle);

  console.log("=".repeat(72));
  console.log(`HandiEdge — NPB slate for ${date}`);
  console.log("=".repeat(72));
  for (const g of bundle.games) {
    const sp = (id: number | null) =>
      id !== null && bundle.starters[String(id)] ? "✓" : "✗";
    console.log(
      `  ${g.gamePk}  ${g.away.teamName} @ ${g.home.teamName}` +
        `  (SP ${g.away.probablePitcherName ?? "未発表"} ${sp(g.away.probablePitcherId)}` +
        ` vs ${g.home.probablePitcherName ?? "未発表"} ${sp(g.home.probablePitcherId)})`,
    );
  }
  console.log(
    `  Derived NPB constants: lgFIP ${bundle.leagueConstants!.lgFIP}, ` +
      `cFIP ${bundle.leagueConstants!.cFIP}, lgwOBA ${bundle.leagueConstants!.wOBA}, ` +
      `R/PA ${bundle.leagueConstants!.runsPerPA} (season key ${bundle.season}).`,
  );
  for (const n of report.notes) console.log(`    - ${n}`);
  console.log(`  Slate written → ${outPath}`);

  // Odds matching needs the English club names The Odds API speaks.
  const oddsGames = bundle.games.map((g) => ({
    ...g,
    home: {
      ...g.home,
      teamName: teamById(g.home.teamId!)?.oddsName ?? g.home.teamName,
    },
    away: {
      ...g.away,
      teamName: teamById(g.away.teamId!)?.oddsName ?? g.away.teamName,
    },
  }));
  const ctPath = await writeSkeletonAndFillOdds(
    date,
    bundle.season,
    bundle.games,
    oddsGames,
  );
  console.log("");
  console.log(
    `Next: pnpm run handiedge predict --league npb --control ${ctPath}`,
  );
}

async function cmdFetchSlate(args: {
  date?: string;
  season?: string;
  out?: string;
  force?: boolean;
  "skip-workloads"?: boolean;
  "skip-form"?: boolean;
  "skip-weather"?: boolean;
  "skip-injuries"?: boolean;
}): Promise<void> {
  if (LEAGUE.league === "npb") return cmdFetchSlateNpb(args);
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

  // IL lists from the 40-man rosters (fail-soft per team; informational —
  // no numeric adjustment is derived, see injuries-builder.ts).
  if (!args["skip-injuries"]) {
    console.log("Fetching 40-man rosters for IL detection…");
    const teamIds = bundle.games
      .flatMap((g) => [g.home.teamId, g.away.teamId])
      .filter((id): id is number => id !== null);
    const inj = await buildInjuries({ client, teamIds, season });
    bundle.injuries = inj.injuries;
    const ilCount = Object.values(inj.injuries).reduce(
      (n, l) => n + l.length,
      0,
    );
    workloadSummary.push(
      `  IL: ${ilCount} player(s) on the IL across ${Object.keys(inj.injuries).length} team(s).`,
      ...inj.warnings.map((w) => `    - injuries: ${w}`),
    );
  } else {
    workloadSummary.push("  IL roster scan skipped (--skip-injuries).");
  }

  // First-pitch weather (Open-Meteo, keyless). Fail-soft per venue; a
  // weatherless game just runs unadjusted with an [info] flag.
  if (!args["skip-weather"]) {
    console.log("Fetching first-pitch weather (Open-Meteo)…");
    const wx = await buildWeather({ date, games: bundle.games });
    bundle.weather = wx.weather;
    workloadSummary.push(
      `  Weather: ${Object.keys(wx.weather).length}/${bundle.games.length} game(s) covered.`,
      ...wx.warnings.map((w) => `    - weather: ${w}`),
    );
  } else {
    workloadSummary.push("  Weather fetch skipped (--skip-weather).");
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
      `teams ${report.teamsFetched}/${report.teamsExpected} (batting+bullpen), ` +
      `lineups posted ${report.lineupsPosted}/${report.games} ` +
      `(${report.lineupBatsFetched} bats fetched).`,
  );
  if (report.warnings.length) {
    console.log("  Warnings:");
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  for (const line of workloadSummary) console.log(line);
  console.log(`  Slate written → ${outPath}`);

  const ctPath = await writeSkeletonAndFillOdds(
    date,
    season,
    bundle.games,
    bundle.games,
  );
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
  const bundleText = await readFile(slatePath, "utf8");
  const bundle = JSON.parse(bundleText) as FixtureBundle;
  // Identity of the input snapshot every pick of this run is computed from.
  // A later --force re-fetch overwrites the slate file, so without this hash
  // a replay cannot tell whether the committed slate is what a frozen pick
  // actually saw (judgment 2: input snapshot identity).
  const inputSha256 = sha256(bundleText);
  // A slate built against a derived environment (NPB) carries its constants;
  // registering them here means the lock is scored with the exact numbers
  // the slate was built from — reproducible across processes.
  if (bundle.leagueConstants) registerSeasonConstants(bundle.leagueConstants);
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

  // Freezing: MLB's whole slate locks at 22:59 JST the evening before the
  // games; a per-game-lock league (NPB) freezes each pick 33 minutes before
  // ITS OWN first pitch. Either way, once a pick's deadline has passed a
  // re-run must carry it through untouched rather than silently rewriting
  // what was already decided — the pick standing at the deadline instant IS
  // the bet, whether or not a later run has stamped it final yet.
  const now = new Date();
  const slateLocked = isPredictionLocked(ct.date, now, LEAGUE.deadlines);
  const gameDeadline = (gameDate: string | null | undefined): Date =>
    gamePredictionDeadline(
      ct.date,
      gameDate,
      LEAGUE.deadlines,
      LEAGUE.perGameLockLeadMinutes,
    );
  const previous = existsSync(lockPath)
    ? await readJson<PredictionLock>(lockPath)
    : null;
  const alreadyFinal = new Map<number, GamePrediction>();
  for (const p of previous?.predictions ?? []) {
    if (predictionFrozen(p, now, slateLocked)) {
      alreadyFinal.set(p.gamePk, { ...p, final: true });
    }
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

    const deadline = gameDeadline(g.gameDate);
    const gameLocked = now.getTime() >= deadline.getTime();
    p.lockDeadline = deadline.toISOString();
    p.final = gameLocked;
    // The instant THIS pick was computed. A pick carried through by a later
    // run keeps its original stamp (the `{ ...p, final: true }` spread above),
    // so the lock records when each bet was actually made — not when the
    // file was last rewritten.
    p.predictedAt = now.toISOString();
    p.inputSha256 = inputSha256;
    if (gameLocked) {
      // Produced after this game's cut-off — recorded as such rather than
      // passed off as a pick that was made in time.
      p.flags = [...p.flags, "[warn] predicted_after_deadline"];
      lateCount++;
    }
    predictions.push(p);
  }

  const lock: PredictionLock = {
    // Carrying even one frozen pick means this run is republishing a slate
    // that was already committed, so the commit time is the earlier one.
    lockedAt:
      carried > 0 && previous?.lockedAt
        ? previous.lockedAt
        : now.toISOString(),
    updatedAt: now.toISOString(),
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

/** NPB results — final scores read off the npb.jp month schedule page. */
async function cmdFetchResultsNpb(
  args: {
    date?: string;
    out?: string;
    force?: boolean;
    settle?: boolean;
    poll?: boolean;
  },
  date: string,
  outPath: string,
): Promise<void> {
  console.log(`Fetching NPB final scores for ${date} from npb.jp…`);
  const report = await fetchNpbResults({ date });
  const finals = Object.keys(report.results).length;

  console.log("=".repeat(72));
  console.log(`HandiEdge — NPB results for ${date}`);
  console.log("=".repeat(72));
  for (const [gamePk, r] of Object.entries(report.results)) {
    console.log(
      `  ${gamePk}: home ${r.homeScore} — away ${r.awayScore}` +
        (r.homeScore === r.awayScore ? "  (draw — moneyline pushes)" : ""),
    );
  }
  for (const p of report.pending) console.log(`  ${p} — PENDING`);
  for (const c of report.cancelled) console.log(`  ${c} — 中止 (never settles)`);

  if (finals === 0) {
    if (args.poll) {
      console.log(
        `No final NPB games for ${date} yet (${report.pending.length} pending) — ` +
          `nothing written; the next poll will pick them up.`,
      );
      return;
    }
    throw new Error(
      `No final NPB games for ${date} yet (${report.pending.length} pending). ` +
        `Nothing written — rerun after the games finish.`,
    );
  }

  // The observed final score is always kept as observed. From the cutover
  // date the SETTLEMENT reads the end-of-9th score instead, so those games
  // are settled only once their regulation score is stored (fail-closed).
  const regulation = productionRule("npb", date).id === "NPB_REGULATION_9";
  let settleResults = report.results;
  let regulationPending: string[] = [];
  if (regulation) {
    const lockPath = join(PRED_DIR, `${date}.json`);
    const lock = existsSync(lockPath) ? await readJson<PredictionLock>(lockPath) : null;
    const reg = await storeRegulationScores(date, lock?.predictions ?? []);
    settleResults = Object.fromEntries(
      Object.entries(reg.games).map(([pk, g]) => [pk, { homeScore: g.homeScore, awayScore: g.awayScore }]),
    );
    regulationPending = reg.pending;
    console.log(`  Settlement basis ${ruleTag(productionRule("npb", date))}: ${Object.keys(settleResults).length} game(s) with a regulation score, ${regulationPending.length} pending`);
  }

  const payload = {
    date,
    fetchedAt: new Date().toISOString(),
    results: report.results,
    pending: report.pending,
    cancelled: report.cancelled,
    ...(regulation ? { settlementRule: ruleTag(productionRule("npb", date)), regulationPending } : {}),
  };
  await saveJson(outPath, payload);
  console.log(`  Results written → ${outPath}`);

  if (args.settle) {
    console.log("");
    if (regulation && Object.keys(settleResults).length === 0) {
      console.log(`No regulation scores for ${date} yet (${regulationPending.length} pending) — nothing settled; the next poll will pick them up.`);
      return;
    }
    await runSettle({ date, results: settleResults });
  } else {
    console.log("");
    console.log(`Next: pnpm run handiedge settle --results ${outPath}`);
  }
}

async function cmdFetchResults(args: {
  date?: string;
  out?: string;
  force?: boolean;
  settle?: boolean;
  poll?: boolean;
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
  if (LEAGUE.league === "npb") return cmdFetchResultsNpb(args, date, outPath);

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
    // Polling mode: the settle job now sweeps the finish window every two
    // hours, and an early sweep finding nothing final yet is the normal
    // case, not a failure.
    if (args.poll) {
      console.log(
        `No final games for ${date} yet (${report.pending.length} pending) — ` +
          `nothing written; the next poll will pick them up.`,
      );
      return;
    }
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

  // Learning paused (Astra judgment 3, PR #33): the active state stays as it
  // is and what learning WOULD have produced is recorded beside it, so the
  // two can be compared later without either having steered the picks.
  const frozen = calibration.frozen;
  const { frozen: _drop, ...shadow } = relearned;
  const league: "mlb" | "npb" = LEAGUE.dataDirName === "data-npb" ? "npb" : "mlb";
  const report = {
    ...scored,
    settlementRule: ruleTag(productionRule(league, payload.date)),
    calibrationBefore: calibration,
    calibrationAfter: frozen ? calibration : relearned,
    ...(frozen ? { calibrationShadowAfter: shadow } : {}),
  };
  await saveHistory(merged.map((r) => (r.date === report.date ? report : r)));
  if (frozen) {
    await saveJson(CALIBRATION_SHADOW_PATH, { ...shadow, shadowOf: CALIBRATION_PATH, frozenSince: frozen.since });
  } else {
    await saveJson(CALIBRATION_PATH, relearned);
  }
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
      `tail ${report.calibrationBefore.tailShrink} → ${report.calibrationAfter.tailShrink}, ` +
      `far tail ${report.calibrationBefore.farTailShrink} → ${report.calibrationAfter.farTailShrink} ` +
      `(${report.calibrationAfter.gamesSettled} games settled lifetime)`,
  );
  if (frozen) {
    console.log(
      `  Calibration FROZEN since ${frozen.since} (${frozen.reason}); ` +
        `learning recorded to ${CALIBRATION_SHADOW_PATH} only.`,
    );
  }
  console.log(`  History appended → ${HISTORY_PATH}`);
}

/**
 * Step 9 — run the AI reviewer panel over a LOCKED slate and save the
 * briefing to data/reviews/<date>.md. Advisory only: nothing about the lock
 * changes. Skips (exit 0) when no Anthropic credential is available, so the
 * daily pipeline works with or without the ANTHROPIC_API_KEY secret.
 */
/**
 * A credential that cannot be put in an HTTP header, caught BEFORE the SDK
 * turns it into one.
 *
 * The SDK sends the key as the `x-api-key` header, and a header value must be
 * a ByteString — every code unit ≤ 255. A key carrying anything else fails
 * inside `fetch` with a message that names neither the key nor the variable:
 *
 *   Cannot convert argument to a ByteString because the character at index 79
 *   has a value of 1061 which is greater than 255
 *
 * That is what a real 2026-08-23 run reported. 1061 is U+0425, CYRILLIC
 * CAPITAL LETTER HA — visually identical to a Latin "X", invisible in the
 * GitHub secret UI, and impossible to spot by eye. Anthropic keys are plain
 * ASCII, so any non-ASCII code point means the secret was mangled in transit
 * (an IME, an autocorrect, a copy from rendered HTML) and the fix is to
 * re-copy it, not to debug the pipeline.
 *
 * Surrounding whitespace gets the same treatment: a trailing newline pasted
 * into the secret box is a byte the header cannot carry either, and it is the
 * other way these credentials arrive broken.
 */
export function assertCredentialIsHeaderSafe(
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const) {
    const value = env[name];
    if (!value) continue;
    if (value !== value.trim()) {
      throw new Error(
        `${name} has leading or trailing whitespace (often a newline pasted ` +
          `into the secret box). Re-add the secret with no surrounding blanks.`,
      );
    }
    // eslint-disable-next-line no-control-regex
    const bad = /[^\x20-\x7e]/.exec(value);
    if (bad) {
      const codePoint = bad[0]!.codePointAt(0)!;
      throw new Error(
        `${name} contains a non-ASCII character at index ${bad.index} ` +
          `(U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}) and ` +
          `cannot be sent as an HTTP header. Anthropic keys are plain ASCII, ` +
          `so this one was mangled on the way into the secret — a lookalike ` +
          `such as U+0425 (Cyrillic Х) is indistinguishable from Latin X by ` +
          `eye. Copy the key straight from console.anthropic.com and re-add ` +
          `the secret; do not retype it.`,
      );
    }
  }
}

/**
 * Is this failure "the account cannot pay", as opposed to something worth
 * failing on?
 *
 * The API reports credit exhaustion as a 400 `invalid_request_error` whose
 * message names the credit balance — verified against a real run
 * (`req_011CeLVWQtUav3RT3EA3ivA4`, 2026-08-23):
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":
 *   "Your credit balance is too low to access the Anthropic API. ..."}}
 *
 * Matched on the message because that is the only part of the response that
 * distinguishes it from every other 400 — a malformed request is the same
 * status and type. Matching on status alone would swallow real bugs, so the
 * text is the narrower and therefore safer signal here; if the wording ever
 * changes, this stops matching and the error goes back to being loud, which
 * is the correct direction to fail in.
 */
export function isBillingUnavailable(e: unknown): boolean {
  const message =
    e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /credit balance is too low|billing|purchase credits/i.test(message);
}

async function cmdReview(args: { date?: string }): Promise<void> {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD (got "${date}")`);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(
      "AI review skipped: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN set. " +
        "Add the secret to run the reviewer panel.",
    );
    return;
  }
  assertCredentialIsHeaderSafe();
  const lockPath = join(PRED_DIR, `${date}.json`);
  if (!existsSync(lockPath)) {
    throw new Error(`No prediction lock for ${date} (${lockPath}) — run predict first.`);
  }
  const lock = await readJson<PredictionLock>(lockPath);
  const slatePath = join(SLATE_DIR, `${date}.json`);
  const bundle = existsSync(slatePath)
    ? await readJson<FixtureBundle>(slatePath)
    : null;

  console.log(
    `Running the AI reviewer panel (${REVIEWER_ROLES.length} roles, ${REVIEW_MODEL_ID}) for ${date}…`,
  );
  const payload = buildReviewPayload({
    date,
    predictions: lock.predictions,
    calibration: lock.calibration,
    bundle,
  });
  let result;
  try {
    result = await runAiReview(payload, anthropicReviewModel());
  } catch (e) {
    // An account with no credits is not a broken pipeline — it is the
    // reviewer being UNAVAILABLE, operationally identical to the missing-key
    // case handled above, and it will be the standing state until somebody
    // buys credits. Failing hard on it would paint every daily run red for a
    // condition no code change can fix, and would bury the failures that do
    // mean something. So: say it plainly, once, and exit clean.
    //
    // Deliberately narrow. Every other API failure — a rejected key, a rate
    // limit, a 500, a network drop — still throws, because those are either
    // fixable misconfiguration or worth retrying, and silence would hide
    // them. Advisory-only output is what makes the clean exit safe: no pick
    // depends on this file existing (model-plan §4.5).
    if (!isBillingUnavailable(e)) throw e;
    console.log(
      "AI review skipped: the Anthropic account has no credits " +
        "(the API answered 'credit balance is too low'). The picks are " +
        "unaffected — the reviewer panel is advisory-only and changes no " +
        "pick. Add credits at console.anthropic.com/settings/billing to " +
        "turn it back on.",
    );
    return;
  }
  const outPath = join(DATA_DIR, "reviews", `${date}.md`);
  await saveMarkdown(outPath, reviewToMarkdown(date, result));
  console.log(`AI review → ${outPath}`);
  for (const s of result.sections) {
    console.log(`  ${s.role.title}: ${s.findings.split("\n")[0] ?? ""}`);
  }
}

async function cmdReport(): Promise<void> {
  if (!existsSync(HISTORY_PATH)) {
    console.log(
      `No history yet (${HISTORY_PATH} missing). Run settle or ` +
        "fetch-results --settle after games finish, then try again.",
    );
    return;
  }
  const s = aggregateHistory(await loadHistory(), LEAGUE.dataDirName === "data-npb" ? "npb" : "mlb");
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
  console.log(
    `  Total:    ${marketRecordLabel(s.totalRecord, TOTAL_MARKET_NEVER_QUOTED)}`,
  );
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
          `(${c.rate === null ? "no decided winner bet" : `${(c.rate * 100).toFixed(1)}%`}, ` +
          `${fmtUnits(c.profit)} units over ${c.staked} stake(s), n=${c.n} decided)`,
      );
    }
  }
  console.log(
    `  Learned shrink (core/tail/far): moneyline ${calibration.shrink}/${calibration.tailShrink}/${calibration.farTailShrink}, ` +
      `handicap ${calibration.handicapShrink}/${calibration.handicapTailShrink}/${calibration.handicapFarTailShrink}, ` +
      `total ${calibration.totalShrink}/${calibration.totalTailShrink}/${calibration.totalFarTailShrink} ` +
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
  const report = runAudit(
    days,
    history,
    calibration,
    new Date(),
    LEAGUE.deadlines,
    LEAGUE.perGameLockLeadMinutes != null,
  );
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
/**
 * Parse a numeric flag, refusing anything that is not a finite number.
 *
 * `Number("4.5x")` is NaN and `Number("")` is 0 — both flow into the engine
 * as if they were parameters, and NaN in particular changes which generative
 * model runs without changing anything visible in the output. A flag the user
 * typed and the tool then ignored is a lie about what was measured, so a bad
 * value stops the run.
 */
function numericArg(
  flag: string,
  raw: string | undefined,
  fallback: number | string,
  bounds?: { min?: number; exclusiveMin?: boolean; allowInfinite?: boolean },
): number {
  const source = raw ?? fallback;
  // `Number("")` is 0 — an empty flag value is a mistake, not a zero.
  if (source === "") throw new Error(`${flag} was given an empty value`);
  const value = Number(source);
  if (Number.isNaN(value)) {
    throw new Error(`${flag} must be a number (got ${JSON.stringify(raw)})`);
  }
  if (!Number.isFinite(value) && !bounds?.allowInfinite) {
    throw new Error(`${flag} must be finite (got ${value})`);
  }
  if (bounds?.min !== undefined) {
    const bad = bounds.exclusiveMin ? value <= bounds.min : value < bounds.min;
    if (bad) {
      throw new Error(
        `${flag} must be ${bounds.exclusiveMin ? ">" : ">="} ${bounds.min} (got ${value})`,
      );
    }
  }
  return value;
}

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
  const season = numericArg("--season", args.season, args.from.slice(0, 4));
  const sims = numericArg("--sims", args.sims, 10_000);
  // Candidate simulator parameters. Omitted = the production constants, so a
  // plain run IS the production engine; set them to trial a refit against
  // the same real record before touching the defaults.
  //
  // Parsed through `numericArg` rather than bare `Number()`: a typo used to
  // yield NaN, which `negBinomial` treats as "no dispersion" and answers with
  // a plain Poisson — the PRE-REFIT engine — while the output files are still
  // tagged as a candidate run. A multi-hour replay that silently measures the
  // wrong model is worse than one that refuses to start.
  const simParams: SimParams = {};
  if (args.dispersion !== undefined) {
    // `Infinity` is a legitimate request: it is the Poisson limit of the
    // negative binomial, i.e. the pre-refit baseline, and typing it out is
    // the only way to reach it.
    simParams.dispersion = numericArg("--dispersion", args.dispersion, NaN, {
      min: 0,
      exclusiveMin: true,
      allowInfinite: true,
    });
  }
  if (args["env-sd"] !== undefined) {
    simParams.envSd = numericArg("--env-sd", args["env-sd"], NaN, { min: 0 });
  }
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
      `${outcome.calibration.shrink}/${outcome.calibration.tailShrink}/${outcome.calibration.farTailShrink}, ` +
      `handicap ${outcome.calibration.handicapShrink}/${outcome.calibration.handicapTailShrink}/${outcome.calibration.handicapFarTailShrink} (core/tail/far)._`,
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
  const summaryFile = join(outDir, `${tag}-summary.md`);
  await writeFile(summaryFile, md.join("\n"), "utf8");
  // Hand the EXACT file back to the workflow. A glob on from_to also matches
  // every candidate-parameter run of the same period, so the job summary used
  // to concatenate two different backtests into one page and present them as
  // a single result. Only this run knows which file this run wrote.
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `summary=${summaryFile}\n`, "utf8");
  }

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

// ---------------------------------------------------------------------------
// Settlement-rule versioning: regulation-score store, re-evaluation, replay
// (.ai/ASTRA_REVIEW_POLICY.md Appendix A; PR #33 judgments 1–3).
// ---------------------------------------------------------------------------

async function loadReevaluations(): Promise<ReevaluationRecord[]> {
  if (!existsSync(REEVAL_PATH)) return [];
  const raw = await readFile(REEVAL_PATH, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ReevaluationRecord);
}

async function readNdjson<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/**
 * Import end-of-9th scores from a VORTE EV archive checkout (the sister
 * project derives them from npb.jp score pages, with a self-check that games
 * ending in ≤ 9 innings match their final score). Joined on (date, home
 * team name); only dates with a prediction lock are imported. Files are
 * append-only: an existing date is verified identical, never rewritten.
 */
async function cmdImportRegulationScores(args: {
  from?: string;
  "provenance-commit"?: string;
}): Promise<void> {
  if (LEAGUE.dataDirName !== "data-npb") throw new Error("import-regulation-scores is NPB only (--league npb)");
  if (!args.from) throw new Error("import-regulation-scores requires --from <dir with games/teams/leagues/game_regulation_scores.ndjson>");
  if (!args["provenance-commit"]) throw new Error("import-regulation-scores requires --provenance-commit <archive commit sha>");
  const dir = resolve(args.from);
  type Team = { id: string; league_id: string; name: string };
  type League = { id: string; name: string; is_official?: boolean };
  type Game = { id: string; league_id: string; game_date: string; home_team_id: string; away_team_id: string };
  type Reg = {
    id: string; game_id: string; home_score_reg: number; away_score_reg: number; regulation_innings: number;
    innings_played: number; source: string; url: string; supersedes_id: string | null; observed_at: string;
  };
  const leagues = await readNdjson<League>(join(dir, "leagues.ndjson"));
  const npb = new Set(leagues.filter((l) => l.is_official && /nippon professional baseball|^NPB$/i.test(l.name)).map((l) => l.id));
  if (npb.size === 0) throw new Error("no official NPB league in leagues.ndjson");
  const teams = new Map((await readNdjson<Team>(join(dir, "teams.ndjson"))).map((t) => [t.id, t]));
  const games = new Map((await readNdjson<Game>(join(dir, "games.ndjson"))).filter((g) => npb.has(g.league_id)).map((g) => [g.id, g]));
  const regs = (await readNdjson<Reg>(join(dir, "game_regulation_scores.ndjson"))).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  // Latest observation per game wins (VORTE supersedes by appending).
  const byKey = new Map<string, { reg: Reg; game: Game }>();
  for (const r of regs) {
    const g = games.get(r.game_id);
    if (!g) continue;
    byKey.set(`${g.game_date}|${teams.get(g.home_team_id)?.name ?? "?"}`, { reg: r, game: g });
  }
  const rule = ruleById("NPB_REGULATION_9");
  const now = new Date().toISOString();
  let written = 0;
  let verified = 0;
  let missing = 0;
  for (const f of (await import("node:fs")).readdirSync(PRED_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const date = f.slice(0, -5);
    const lock = await readJson<PredictionLock>(join(PRED_DIR, f));
    const file: RegulationScoreFile = {
      date,
      rule: ruleTag(rule),
      importedAt: now,
      provenance: {
        kind: "vorte-ev-archive",
        commit: args["provenance-commit"],
        note: "game_regulation_scores.ndjson joined to games/teams on (game_date, home team name); each row keeps npb.jp score-page url and observed_at",
      },
      games: {},
    };
    for (const p of lock.predictions) {
      const hit = byKey.get(`${date}|${p.home}`);
      if (!hit) { missing++; continue; }
      const awayName = teams.get(hit.game.away_team_id)?.name;
      if (awayName !== p.away) { missing++; console.warn(`  ${date} ${p.away} @ ${p.home}: away team mismatch in archive (${awayName}) — skipped`); continue; }
      const r = hit.reg;
      const score: RegulationScore = {
        homeScore: r.home_score_reg, awayScore: r.away_score_reg, regulationInnings: r.regulation_innings,
        inningsPlayed: r.innings_played, source: r.source, url: r.url, observedAt: r.observed_at,
      };
      file.games[String(p.gamePk)] = score;
    }
    const path = join(REGULATION_DIR, `${date}.json`);
    if (existsSync(path)) {
      const existing = await readJson<RegulationScoreFile>(path);
      if (JSON.stringify(existing.games) !== JSON.stringify(file.games)) {
        throw new Error(`${path} exists with different scores; the store is append-only — investigate before importing (no file was changed)`);
      }
      verified++;
      continue;
    }
    await saveJson(path, file);
    written++;
    console.log(`  ${date}: ${Object.keys(file.games).length}/${lock.predictions.length} games → ${path}`);
  }
  console.log(`Regulation scores: ${written} date file(s) written, ${verified} verified unchanged, ${missing} game(s) without a score.`);
}

/**
 * Fetch end-of-9th scores from npb.jp for the lock's games and merge them
 * into data-npb/regulation-scores/<date>.json. Append-only: a game already
 * stored is verified identical, never rewritten; new games are added.
 */
async function storeRegulationScores(
  date: string,
  predictions: GamePrediction[],
): Promise<{ games: RegulationScoreFile["games"]; pending: string[]; added: number }> {
  const path = join(REGULATION_DIR, `${date}.json`);
  const existing = existsSync(path) ? await readJson<RegulationScoreFile>(path) : null;
  const rule = ruleById("NPB_REGULATION_9");
  const todo = predictions.filter((p) => !existing?.games[String(p.gamePk)]);
  const fetched = todo.length === 0
    ? { scores: {}, pending: [] }
    : await fetchNpbRegulationScores({
        date,
        games: todo.map((p) => ({ gamePk: p.gamePk, home: p.home, away: p.away })),
        fetchPage: (url) => fetchNpbPage(url),
      });
  const games: RegulationScoreFile["games"] = { ...(existing?.games ?? {}) };
  for (const [pk, s] of Object.entries(fetched.scores)) {
    games[pk] = {
      homeScore: s.homeScore, awayScore: s.awayScore, regulationInnings: s.regulationInnings,
      inningsPlayed: s.inningsPlayed, source: s.source, url: s.url, observedAt: s.observedAt,
    };
    console.log(`  ${pk}: regulation ${s.awayScore}-${s.homeScore} after ${s.inningsPlayed} inn (final ${s.finalAway}-${s.finalHome}) ← ${s.url}`);
  }
  for (const p of fetched.pending) console.log(`  ${p.gamePk} ${p.matchup}: regulation score PENDING — ${p.reason}`);
  const added = Object.keys(fetched.scores).length;
  if (added > 0 || !existing) {
    const file: RegulationScoreFile = {
      date,
      rule: ruleTag(rule),
      importedAt: existing?.importedAt ?? new Date().toISOString(),
      provenance: existing?.provenance ?? { kind: "npb.jp", commit: "", note: "fetched by handiedge fetch-results/fetch-regulation-scores from npb.jp game pages (inning line, ≤9-inning self-check)" },
      games,
    };
    await saveJson(path, file);
  }
  return { games, pending: fetched.pending.map((p) => p.matchup), added };
}

async function cmdFetchRegulationScores(args: { date?: string }): Promise<void> {
  if (LEAGUE.dataDirName !== "data-npb") throw new Error("fetch-regulation-scores is NPB only (--league npb)");
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const lockPath = join(PRED_DIR, `${date}.json`);
  if (!existsSync(lockPath)) throw new Error(`No NPB prediction lock for ${date} (${lockPath}); nothing to look up.`);
  const lock = await readJson<PredictionLock>(lockPath);
  const out = await storeRegulationScores(date, lock.predictions);
  console.log(`Regulation scores for ${date}: ${Object.keys(out.games).length} stored (${out.added} new), ${out.pending.length} pending.`);
}

/**
 * Re-evaluate every locked pick under another settlement rule and APPEND the
 * records to reevaluations.jsonl. history.jsonl and calibration.json are not
 * touched; the report shows original vs re-evaluated side by side.
 */
async function cmdReevaluate(args: { rule?: string }): Promise<void> {
  if (!args.rule) throw new Error("reevaluate requires --rule <SETTLEMENT_RULE_ID>");
  const rule = ruleById(args.rule);
  const league: "mlb" | "npb" = LEAGUE.dataDirName === "data-npb" ? "npb" : "mlb";
  if (rule.league !== league) throw new Error(`${rule.id} is a ${rule.league} rule; run with --league ${rule.league}`);
  if (rule.status === "production") throw new Error(`${rule.id} is the production rule; reevaluate is for other rules`);
  const originalRule = productionRule(league, rule.appliesFrom ?? undefined);
  const history = new Map((await loadHistory()).map((r) => [r.date, r]));
  const existing = await loadReevaluations();
  const version = codeVersion();
  const now = new Date();
  const appended: ReevaluationRecord[] = [];
  const unevaluated: { date: string; matchup: string; reason: string }[] = [];
  for (const f of (await import("node:fs")).readdirSync(PRED_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const date = f.slice(0, -5);
    if (rule.appliesFrom && date < rule.appliesFrom) continue;
    const dateRule = productionRule(league, date);
    if (dateRule.id === rule.id) continue; // already settled under this rule in production — nothing to re-evaluate
    const lock = await readJson<PredictionLock>(join(PRED_DIR, f));
    const regPath = join(REGULATION_DIR, `${date}.json`);
    const regulation = existsSync(regPath) ? await readJson<RegulationScoreFile>(regPath) : null;
    const out = reevaluateDate({
      league, date, predictions: lock.predictions, calibration: lock.calibration, regulation,
      original: history.get(date) ?? null, rule, originalRule: dateRule, codeVersion: version, now,
      reason: `${ruleTag(rule)} is the handicap market's basis; history.jsonl was scored under ${ruleTag(originalRule)}`,
    });
    for (const u of out.unevaluated) unevaluated.push({ date, matchup: u.matchup, reason: u.reason });
    appended.push(...newRecords([...existing, ...appended], out.records));
  }
  if (appended.length > 0) {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(REEVAL_PATH, appended.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  const all = [...existing, ...appended].filter((r) => r.rule.id === rule.id && r.rule.version === rule.version);
  const s = summarizeReevaluations(all);
  const md: string[] = [];
  md.push(`# Re-evaluation under ${ruleTag(rule)} (original: ${ruleTag(originalRule)})`);
  md.push("");
  md.push(`_Appended to ${REEVAL_PATH}; history.jsonl and calibration.json unchanged. Records are keyed by prediction + rule version + result observation, so re-runs append nothing new. Basis: ${rule.basis}._`);
  md.push("");
  md.push(`- records: ${s.records} (with an original evaluation: ${s.withOriginal}); appended this run: ${appended.length}`);
  md.push(`- changed vs original — winner: ${s.changedWinner}, handicap: ${s.changedHandicap}, total: ${s.changedTotal}, handicap profit: ${s.changedProfit}`);
  md.push(`- unevaluated (no regulation score; never filled from the posted final): ${unevaluated.length}`);
  md.push("");
  md.push("| date | game | original (final posted) | re-evaluated (regulation) | changed |");
  md.push("|---|---|---|---|---|");
  md.push(...s.rows);
  if (unevaluated.length > 0) {
    md.push("");
    md.push("## Unevaluated");
    for (const u of unevaluated) md.push(`- ${u.date} ${u.matchup}: ${u.reason}`);
  }
  md.push("");
  md.push(`_Evaluator code version ${version}; generated ${now.toISOString()}._`);
  await saveMarkdown(join(REPORTS_DIR, `reevaluation-${rule.id}.md`), md.join("\n") + "\n");
  console.log(`Re-evaluated ${s.records} pick(s) under ${ruleTag(rule)}: ${appended.length} new record(s), ${unevaluated.length} unevaluated.`);
}

/**
 * Replay every lock from its committed slate with the current code and seal
 * the outputs (judgment 2). --data-dir lets the BASE checkout's code read the
 * HEAD's data so both sides see identical inputs.
 */
async function cmdReplay(args: {
  out?: string;
  "data-dir"?: string;
  from?: string;
  to?: string;
  dispersion?: string;
  "env-sd"?: string;
}): Promise<void> {
  if (!args.out) throw new Error("replay requires --out <dir>");
  const league: "mlb" | "npb" = LEAGUE.dataDirName === "data-npb" ? "npb" : "mlb";
  const simParams: { dispersion?: number; envSd?: number } = {};
  if (args.dispersion !== undefined) simParams.dispersion = numericArg("--dispersion", args.dispersion, NaN, { min: 0, exclusiveMin: true, allowInfinite: true });
  if (args["env-sd"] !== undefined) simParams.envSd = numericArg("--env-sd", args["env-sd"], NaN, { min: 0 });
  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });
  const history = await loadHistory();
  const version = codeVersion();
  const now = new Date();
  const manifest: {
    source: "replay"; league: string; codeVersion: string; replayedAt: string; dataDir: string; simParams: typeof simParams;
    dates: { date: string; file: string; sha256: string; predictionsSha256: string; reproduction: ReplayOutput["reproduction"]; calibrationAsOf: boolean | null; slateFetchedAt: string | null }[];
    skipped: { date: string; reason: string }[];
  } = { source: "replay", league, codeVersion: version, replayedAt: now.toISOString(), dataDir: DATA_DIR, simParams, dates: [], skipped: [] };
  for (const f of (await import("node:fs")).readdirSync(PRED_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const date = f.slice(0, -5);
    if ((args.from && date < args.from) || (args.to && date > args.to)) continue;
    const slatePath = join(SLATE_DIR, `${date}.json`);
    if (!existsSync(slatePath)) { manifest.skipped.push({ date, reason: "no committed slate" }); continue; }
    const lock = await readJson<PredictionLock>(join(PRED_DIR, f));
    const bundleText = await readFile(slatePath, "utf8");
    const bundle = JSON.parse(bundleText) as FixtureBundle;
    if (bundle.date !== date) { manifest.skipped.push({ date, reason: `slate is for ${bundle.date}` }); continue; }
    const out = await replayLock({ league, lock, bundle, bundleText, history, codeVersion: version, now, simParams });
    const text = JSON.stringify(out, null, 2);
    await writeFile(join(outDir, `${date}.json`), text, "utf8");
    manifest.dates.push({
      date, file: `${date}.json`, sha256: sha256(text), predictionsSha256: out.predictionsSha256,
      reproduction: out.reproduction, calibrationAsOf: out.calibrationAsOf.verified, slateFetchedAt: out.input.slateFetchedAt,
    });
    console.log(`  ${date}: ${out.predictions.length} replayed, reproduced ${out.reproduction.matched}/${out.reproduction.compared}, calibration as-of ${out.calibrationAsOf.verified}`);
  }
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Replay (${version}) → ${outDir}: ${manifest.dates.length} date(s), ${manifest.skipped.length} skipped.`);
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
      poll: { type: "boolean", default: false },
      "skip-workloads": { type: "boolean", default: false },
      from: { type: "string" },
      to: { type: "string" },
      sims: { type: "string" },
      dispersion: { type: "string" },
      "env-sd": { type: "string" },
      "skip-form": { type: "boolean", default: false },
      "skip-weather": { type: "boolean", default: false },
      "skip-injuries": { type: "boolean", default: false },
      league: { type: "string" },
      "data-dir": { type: "string" },
      rule: { type: "string" },
      "provenance-commit": { type: "string" },
    },
  });
  // League first: every path and deadline the commands read derives from it.
  setLeague(resolveLeague(values.league ?? process.env["HANDIEDGE_LEAGUE"]));
  // Any command can be pointed at another store (tests, and the replay of
  // the PR head's data by the base checkout's code).
  if (values["data-dir"]) setDataDir(values["data-dir"]);
  const cmd = positionals[0];
  if (cmd === "fetch-slate") await cmdFetchSlate(values);
  else if (cmd === "fetch-results") await cmdFetchResults(values);
  else if (cmd === "predict") await cmdPredict(values);
  else if (cmd === "settle") await cmdSettle(values);
  else if (cmd === "report") await cmdReport();
  else if (cmd === "review") await cmdReview(values);
  else if (cmd === "audit") await cmdAudit();
  else if (cmd === "backtest") await cmdBacktest(values);
  else if (cmd === "import-regulation-scores") await cmdImportRegulationScores(values);
  else if (cmd === "reevaluate") await cmdReevaluate(values);
  else if (cmd === "fetch-regulation-scores") await cmdFetchRegulationScores(values);
  else if (cmd === "replay") await cmdReplay(values);
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
    console.log(
      "  handiedge review        [--date YYYY-MM-DD]   (needs ANTHROPIC_API_KEY)",
    );
    console.log("  handiedge audit");
    console.log("  handiedge replay        --out <dir> [--data-dir <league data dir>] [--from/--to] [--dispersion r] [--env-sd s]");
    console.log("  handiedge reevaluate    --rule NPB_REGULATION_9   (--league npb; appends reevaluations.jsonl)");
    console.log(`  handiedge fetch-regulation-scores [--date YYYY-MM-DD]   (--league npb; end-of-9th scores from npb.jp; production basis from ${NPB_PRODUCTION_CUTOVER})`);
    console.log("  handiedge import-regulation-scores --from <vorte archive dir> --provenance-commit <sha>   (--league npb)");
    console.log(
      "  handiedge backtest      --from YYYY-MM-DD --to YYYY-MM-DD [--season YYYY] [--sims N] [--dispersion R] [--env-sd S]",
    );
    console.log(
      "  Every command accepts --league mlb|npb (default mlb; or set " +
        "HANDIEDGE_LEAGUE). NPB keeps its own store under data-npb/.",
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
