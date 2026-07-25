/**
 * @workspace/pipeline — the TypeScript orchestration half of the AI Sports Lab
 * prediction pipeline: Prediction Lock (Component 4) and Settlement (Component 5),
 * bridging the Python engine's predictions to the AI review and to the Python
 * error-analysis / self-learning stages.
 */

export { lockPrediction, lockPredictions, verifyLock } from "./lock.js";
export type { LockOptions } from "./lock.js";
export { settle } from "./settlement.js";

export type {
  EnginePredictionsFile,
  GameResult,
  LockFile,
  LockedPrediction,
  LockedReview,
  MoneylineSide,
  Picks,
  ResultsFile,
  SettledBet,
  SettledFile,
  SettledPrediction,
  TotalSide,
} from "./types.js";
