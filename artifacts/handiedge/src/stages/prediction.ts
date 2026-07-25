/**
 * Stage 3 — Prediction Engine (with the Ensemble).
 *
 * Combines the trained logistic model with the transparent baseline into one
 * home-win probability, and reports how much the two agree (a fragility signal
 * used later by the AI review / Risk Reviewer). Home-cover probability is
 * derived from the win probability via the historical "win by 2+ | win" rate.
 */
import { baselinePredict } from "../model/baseline.js";
import { predictLogistic, type LogisticModel } from "../model/logistic.js";
import { toVector } from "./features.js";
import { predictionSchema, type FeatureRow, type Prediction } from "../schemas.js";

export const COVER_GIVEN_WIN = 0.62;

export interface EnsembleWeights {
  logistic: number;
  baseline: number;
}

export interface ModelBundle {
  winModel: LogisticModel | null;
  weights: EnsembleWeights;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function runPrediction(row: FeatureRow, bundle: ModelBundle): Prediction {
  const baselineP = clamp01(baselinePredict(row.features).homeWinProb);
  const predictedTotal = baselinePredict(row.features).predictedTotal;

  let logisticP = baselineP;
  let homeWinProbRaw = baselineP;
  if (bundle.winModel) {
    logisticP = clamp01(predictLogistic(bundle.winModel, toVector(row.features)));
    const wl = bundle.weights.logistic;
    const wb = bundle.weights.baseline;
    const total = wl + wb || 1;
    homeWinProbRaw = clamp01((wl * logisticP + wb * baselineP) / total);
  }

  const componentAgreement = clamp01(1 - Math.abs(logisticP - baselineP) / 0.25);
  const coversProbRaw = clamp01(homeWinProbRaw * COVER_GIVEN_WIN);

  return predictionSchema.parse({
    gameId: row.gameId,
    homeWinProbRaw,
    logisticP,
    baselineP,
    coversProbRaw,
    predictedTotal,
    componentAgreement,
  });
}
