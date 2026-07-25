/**
 * Stage 9 — Self-Learning Engine.
 * Closes the loop: nudges the ensemble weights from the over/under-confidence
 * signal (over-confident → lean on the conservative baseline), and flags
 * recalibration when calibration error is high. The new weights are returned so
 * the caller can persist them for the next run to pick up.
 */
import {
  learningUpdateSchema,
  type ErrorReport,
  type LearningUpdate,
} from "../schemas.js";
import type { EnsembleWeights } from "./prediction.js";

const MAX_STEP = 0.05;
const MIN_LOGISTIC = 0.2;
const MAX_LOGISTIC = 0.8;
const DEADBAND = 0.02;
const ECE_THRESHOLD = 0.05;

export function selfLearn(report: ErrorReport, prev: EnsembleWeights): LearningUpdate {
  const rationale: string[] = [];
  let logistic = prev.logistic;

  if (Math.abs(report.overconfidenceSignal) <= DEADBAND) {
    rationale.push(
      `Overconfidence signal ${report.overconfidenceSignal.toFixed(3)} within deadband; weights unchanged.`,
    );
  } else {
    const step = report.overconfidenceSignal > 0 ? MAX_STEP : -MAX_STEP;
    logistic = Math.min(MAX_LOGISTIC, Math.max(MIN_LOGISTIC, logistic - step));
    const dir =
      report.overconfidenceSignal > 0 ? "toward baseline (over-confident)" : "toward logistic (under-confident)";
    rationale.push(
      `Overconfidence signal ${report.overconfidenceSignal.toFixed(3)} → shifted ${Math.abs(step).toFixed(2)} ${dir}.`,
    );
  }

  const newWeights: EnsembleWeights = {
    logistic: Number(logistic.toFixed(4)),
    baseline: Number((1 - logistic).toFixed(4)),
  };

  const recalibrate = report.calibrationEce > ECE_THRESHOLD;
  rationale.push(
    recalibrate
      ? `Calibration error ${report.calibrationEce.toFixed(3)} exceeds ${ECE_THRESHOLD}; recommend retrain/recalibration.`
      : `Calibration error ${report.calibrationEce.toFixed(3)} acceptable.`,
  );

  return learningUpdateSchema.parse({
    date: report.date,
    prevWeights: prev,
    newWeights,
    recalibrate,
    rationale,
  });
}
