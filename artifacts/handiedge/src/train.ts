/**
 * Training entry point. Reads the recorded history fixture, trains the logistic
 * win model, fits the Platt calibrator on a held-out split, and persists the
 * model artifacts + metrics. Deterministic given the seed.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod/v4";
import { FEATURE_ORDER, fixturePath, modelPath } from "./config.js";
import { writeJson } from "./util/io.js";
import { mulberry32 } from "./util/rng.js";
import { trainLogistic, predictLogistic, type LogisticModel } from "./model/logistic.js";
import { fitCalibrator, type Calibrator } from "./model/calibrator.js";

const historySchema = z.object({
  games: z.array(z.record(z.string(), z.number())),
});

export const WIN_MODEL_FILE = "win_model.json";
export const CALIBRATOR_FILE = "calibrator.json";
export const METRICS_FILE = "training_metrics.json";
export const WEIGHTS_FILE = "ensemble_weights.json";

export interface TrainingMetrics {
  nTrain: number;
  nValid: number;
  auc: number;
  logloss: number;
}

function auc(scores: number[], labels: number[]): number {
  const pos = labels.filter((y) => y === 1).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  const idx = scores.map((s, i) => ({ s, y: labels[i]! })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let i = 0; i < idx.length; i++) if (idx[i]!.y === 1) rankSum += i + 1;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function logloss(scores: number[], labels: number[]): number {
  const eps = 1e-12;
  let s = 0;
  for (let i = 0; i < scores.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, scores[i]!));
    s += -(labels[i]! * Math.log(p) + (1 - labels[i]!) * Math.log(1 - p));
  }
  return s / scores.length;
}

export function train(seed = 42): TrainingMetrics {
  const path = fixturePath("history.json");
  if (!existsSync(path)) {
    throw new Error(`history fixture missing: ${path} (run tools/make-history.ts)`);
  }
  const { games } = historySchema.parse(JSON.parse(readFileSync(path, "utf-8")));

  const X: number[][] = [];
  const y: number[] = [];
  for (const g of games) {
    X.push(FEATURE_ORDER.map((k) => g[k]!));
    y.push(g.home_win!);
  }

  // Deterministic shuffle + split.
  const rng = mulberry32(seed);
  const order = X.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const split = Math.floor(order.length * 0.75);
  const trainIdx = order.slice(0, split);
  const validIdx = order.slice(split);

  const model: LogisticModel = trainLogistic(
    trainIdx.map((i) => X[i]!),
    trainIdx.map((i) => y[i]!),
  );

  const rawValid = validIdx.map((i) => predictLogistic(model, X[i]!));
  const yValid = validIdx.map((i) => y[i]!);
  const calibrator: Calibrator = fitCalibrator(rawValid, yValid);

  const metrics: TrainingMetrics = {
    nTrain: trainIdx.length,
    nValid: validIdx.length,
    auc: Number(auc(rawValid, yValid).toFixed(4)),
    logloss: Number(logloss(rawValid, yValid).toFixed(4)),
  };

  writeJson(modelPath(WIN_MODEL_FILE), model);
  writeJson(modelPath(CALIBRATOR_FILE), calibrator);
  writeJson(modelPath(METRICS_FILE), metrics);
  return metrics;
}
