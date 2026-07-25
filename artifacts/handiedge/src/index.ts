/**
 * HandiEdge — a personal MLB prediction tool.
 *
 * A single-language (TypeScript) pipeline that ingests a slate, predicts each
 * game, decides winner / handicap / PASS, calibrates, runs AI review, locks the
 * pick, and (after games finish) settles, analyzes errors, and self-learns.
 */
export { runPredict, runSettle } from "./pipeline.js";
export type { PipelineOptions, SettleResult } from "./pipeline.js";
export { train } from "./train.js";

// Stage functions (exported for targeted use / testing).
export { runIntake } from "./stages/intake.js";
export { buildFeatures, toVector, windSigned } from "./stages/features.js";
export { runPrediction } from "./stages/prediction.js";
export { decide } from "./stages/decision.js";
export { calibrate } from "./stages/calibration.js";
export { lockGame } from "./stages/lock.js";
export { settle } from "./stages/settlement.js";
export { analyze } from "./stages/errorAnalysis.js";
export { selfLearn } from "./stages/selfLearning.js";

export { trainLogistic, predictLogistic } from "./model/logistic.js";
export { baselinePredict } from "./model/baseline.js";
export { fitCalibrator, applyCalibrator, IDENTITY_CALIBRATOR } from "./model/calibrator.js";
export { FixtureSource, HttpSource, sourceFromEnv } from "./adapters/index.js";

export * from "./schemas.js";
