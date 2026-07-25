/**
 * Stage 5 — Probability Calibration.
 *
 * Maps the raw home-win probability to a calibrated one, then re-derives the
 * decision on that calibrated value — so a game that looked like a play on a
 * mis-calibrated probability can correctly become a PASS (and vice-versa).
 */
import { applyCalibrator, type Calibrator } from "../model/calibrator.js";
import { COVER_GIVEN_WIN } from "./prediction.js";
import { decide } from "./decision.js";
import {
  calibratedDecisionSchema,
  type CalibratedDecision,
  type ControlTower,
  type IntakeGame,
  type Prediction,
} from "../schemas.js";

export function calibrate(
  game: IntakeGame,
  pred: Prediction,
  ctrl: ControlTower,
  calibrator: Calibrator,
): CalibratedDecision {
  const calP = ctrl.calibration.enabled
    ? applyCalibrator(calibrator, pred.homeWinProbRaw)
    : pred.homeWinProbRaw;

  const calibratedPred: Prediction = {
    ...pred,
    homeWinProbRaw: calP,
    coversProbRaw: calP * COVER_GIVEN_WIN,
  };
  const decision = decide(game, calibratedPred, ctrl);
  if (ctrl.calibration.enabled && Math.abs(calP - pred.homeWinProbRaw) > 0.005) {
    decision.reasons.push(
      `Calibrated ${(pred.homeWinProbRaw * 100).toFixed(0)}% → ${(calP * 100).toFixed(0)}% home.`,
    );
  }

  return calibratedDecisionSchema.parse({ ...decision, calibratedHomeWinProb: calP });
}
