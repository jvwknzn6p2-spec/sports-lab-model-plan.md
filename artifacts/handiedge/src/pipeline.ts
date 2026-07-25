/**
 * Pipeline orchestrator — wires the nine stages end to end and persists
 * auditable results plus a reproducibility manifest.
 *
 *   predict path : Intake → Feature → Prediction → Decision → Calibration → Lock
 *   settle path  : Settlement → Error Analysis → Self-Learning
 *
 * Per-game processing is isolated: a single bad game becomes a PASS with an
 * error reason instead of crashing the slate.
 */
import { existsSync, readFileSync } from "node:fs";
import { defaultProvider, HeuristicReviewProvider } from "@workspace/ai-review";
import type { ReviewProvider } from "@workspace/ai-review";
import { modelPath, outPath } from "./config.js";
import { writeJson, writeValidated } from "./util/io.js";
import { sha256 } from "./util/hash.js";
import { AuditLogger } from "./util/audit.js";
import type { IntakeSource } from "./adapters/index.js";
import { sourceFromEnv } from "./adapters/index.js";
import { runIntake } from "./stages/intake.js";
import { buildFeatures } from "./stages/features.js";
import { runPrediction, type EnsembleWeights, type ModelBundle } from "./stages/prediction.js";
import { calibrate } from "./stages/calibration.js";
import { lockGame } from "./stages/lock.js";
import { settle } from "./stages/settlement.js";
import { analyze } from "./stages/errorAnalysis.js";
import { selfLearn } from "./stages/selfLearning.js";
import { IDENTITY_CALIBRATOR, type Calibrator } from "./model/calibrator.js";
import type { LogisticModel } from "./model/logistic.js";
import {
  lockedFileSchema,
  settledFileSchema,
  errorReportSchema,
  learningUpdateSchema,
  type ControlTower,
  type ErrorReport,
  type GameOutput,
  type IntakeGame,
  type LearningUpdate,
  type LockedFile,
  type SettledFile,
} from "./schemas.js";
import { WIN_MODEL_FILE, CALIBRATOR_FILE, WEIGHTS_FILE } from "./train.js";

export interface PipelineOptions {
  source?: IntakeSource;
  provider?: ReviewProvider;
  now?: Date;
}

function loadJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : null;
}

function loadBundle(ctrl: ControlTower): { bundle: ModelBundle; calibrator: Calibrator } {
  const winModel = loadJson<LogisticModel>(modelPath(WIN_MODEL_FILE));
  const calibrator = loadJson<Calibrator>(modelPath(CALIBRATOR_FILE)) ?? IDENTITY_CALIBRATOR;
  // Self-learned weights (if any) override the Control Tower defaults.
  const learned = loadJson<EnsembleWeights>(modelPath(WEIGHTS_FILE));
  const weights = learned ?? ctrl.ensembleWeights;
  return { bundle: { winModel, weights }, calibrator };
}

function pickProvider(ctrl: ControlTower, override?: ReviewProvider): ReviewProvider {
  if (override) return override;
  if (ctrl.review.provider === "heuristic" || !ctrl.review.enabled) {
    return new HeuristicReviewProvider();
  }
  return defaultProvider();
}

function errorOutput(game: IntakeGame, err: unknown): GameOutput {
  const message = err instanceof Error ? err.message : String(err);
  const core = {
    gameId: game.gameId,
    decision: "PASS" as const,
    winner: null,
    loser: null,
    handicapPick: null,
    winProbability: 0.5,
    confidence: "C" as const,
  };
  return {
    ...core,
    matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
    reasons: [`pipeline error: ${message}`],
    passReason: `pipeline error: ${message}`,
    contentHash: sha256(core),
    homeAbbr: game.home.abbreviation,
    awayAbbr: game.away.abbreviation,
    homeWinProbHome: 0.5,
    handicapFavorite: game.handicap.favorite,
    handicapLine: Math.abs(game.handicap.handicap),
    handicapSide: null,
  };
}

export async function runPredict(date: string, opts: PipelineOptions = {}): Promise<LockedFile> {
  const source = opts.source ?? sourceFromEnv();
  const now = opts.now ?? new Date();
  const audit = new AuditLogger(outPath(`audit_${date}.jsonl`), () => now);

  const schedule = await source.loadSchedule(date);
  const handicap = await source.loadHandicap(date);
  const ctrl = await source.loadControlTower("default");
  const { bundle, calibrator } = loadBundle(ctrl);
  const provider = pickProvider(ctrl, opts.provider);

  const intake = runIntake(schedule, handicap);
  audit.stage("intake", { schedule, handicap }, intake, { games: intake.length });

  const games: GameOutput[] = [];
  for (const game of intake) {
    try {
      const features = buildFeatures(game);
      const prediction = runPrediction(features, bundle);
      const decision = calibrate(game, prediction, ctrl, calibrator);
      const output = await lockGame(game, prediction, decision, ctrl, { provider, now });
      audit.stage("game", game, output, { gameId: game.gameId });
      games.push(output);
    } catch (err) {
      audit.error("game", err instanceof Error ? err.message : String(err), {
        gameId: game.gameId,
      });
      games.push(errorOutput(game, err));
    }
  }

  const lockFile: LockedFile = {
    date,
    runLabel: ctrl.runLabel,
    lockedAt: now.toISOString(),
    reviewProvider: provider.kind,
    games,
  };
  writeValidated(outPath(`locked_${date}.json`), lockedFileSchema, lockFile);

  // Reproducibility manifest.
  writeJson(outPath(`manifest_${date}.json`), {
    date,
    runLabel: ctrl.runLabel,
    seed: ctrl.seed,
    source: source.kind,
    reviewProvider: provider.kind,
    generatedAt: now.toISOString(),
    inputHashes: {
      schedule: sha256(schedule),
      handicap: sha256(handicap),
      controlTower: sha256(ctrl),
    },
    modelHashes: {
      winModel: bundle.winModel ? sha256(bundle.winModel) : null,
      calibrator: sha256(calibrator),
      weights: sha256(bundle.weights),
    },
  });
  audit.stage("lock", intake, lockFile, { plays: games.filter((g) => g.decision === "PLAY").length });
  return lockFile;
}

export interface SettleResult {
  settled: SettledFile;
  report: ErrorReport;
  learning: LearningUpdate;
}

export async function runSettle(date: string, opts: PipelineOptions = {}): Promise<SettleResult> {
  const source = opts.source ?? sourceFromEnv();
  const now = opts.now ?? new Date();
  const audit = new AuditLogger(outPath(`audit_${date}.jsonl`), () => now);

  const locked = lockedFileSchema.parse(
    JSON.parse(readFileSync(outPath(`locked_${date}.json`), "utf-8")),
  );
  const results = await source.loadResults(date);
  const ctrl = await source.loadControlTower("default");

  const settled = settle(locked, results);
  writeValidated(outPath(`settled_${date}.json`), settledFileSchema, settled);
  audit.stage("settlement", { locked, results }, settled);

  const report = analyze(settled);
  writeValidated(outPath(`error_report_${date}.json`), errorReportSchema, report);
  audit.stage("errorAnalysis", settled, report);

  const { bundle } = loadBundle(ctrl);
  const learning = selfLearn(report, bundle.weights);
  writeValidated(outPath(`learning_${date}.json`), learningUpdateSchema, learning);
  // Persist new weights for the next run to pick up (closes the loop).
  writeJson(modelPath(WEIGHTS_FILE), learning.newWeights);
  audit.stage("selfLearning", report, learning, { recalibrate: learning.recalibrate });

  return { settled, report, learning };
}
