/**
 * Types for the orchestration half of the pipeline (TypeScript side):
 * Prediction Lock (Component 4) and Settlement (Component 5).
 *
 * These sit between the Python engine's `predictions_<date>.json` (which matches
 * the `@workspace/ai-review` `GamePrediction` contract) and the Python Error
 * Analysis engine's `settled_<date>.json` input.
 */

import type { GamePrediction, ConfidenceRank, ReviewFlag } from "@workspace/ai-review";

/** The engine's prediction file, as emitted by `sportslab-engine predict`. */
export interface EnginePredictionsFile {
  date: string;
  generatedBy: string;
  gbmTrained: boolean;
  predictions: GamePrediction[];
}

export type MoneylineSide = "home" | "away";
export type TotalSide = "over" | "under";

/** The concrete picks distilled from a prediction. */
export interface Picks {
  moneyline: MoneylineSide;
  moneylineProb: number;
  total: TotalSide;
  totalLine: number;
}

/** A compact record of what the AI review concluded, frozen into the lock. */
export interface LockedReview {
  originalConfidence: ConfidenceRank;
  finalConfidence: ConfidenceRank;
  downgraded: boolean;
  warnings: string[];
  flags: ReviewFlag[];
}

/**
 * An immutable, hashed snapshot of a finalized pick. Once locked, a prediction
 * is the record of what we committed to before first pitch — Settlement grades
 * against it, and the hash detects any post-hoc tampering.
 */
export interface LockedPrediction {
  gameId: string;
  lockedAt: string;
  contentHash: string;
  prediction: GamePrediction;
  review: LockedReview;
  picks: Picks;
}

export interface LockFile {
  date: string;
  lockedAt: string;
  reviewProvider: string;
  locked: LockedPrediction[];
}

/** Final scores, as recorded in the results fixture / feed. */
export interface GameResult {
  gameId: string;
  homeScore: number;
  awayScore: number;
}

export interface ResultsFile {
  date: string;
  results: GameResult[];
}

/** One graded, settled bet within a settled prediction. */
export interface SettledBet {
  selection: string;
  positive: boolean;
  /** Realized profit per 1 unit staked (+payout on win, -1 on loss). */
  profit: number;
}

/**
 * A settled prediction — the shape the Python Error Analysis engine consumes.
 * Field names are camelCase to match `error_analysis/analyze.py`.
 */
export interface SettledPrediction {
  gameId: string;
  homeWinProb: number;
  moneylinePick: MoneylineSide;
  moneylineCorrect: boolean;
  finalConfidence: ConfidenceRank;
  totalPick: TotalSide;
  totalCorrect: boolean;
  actualHomeWin: boolean;
  evBets: SettledBet[];
}

export interface SettledFile {
  date: string;
  settled: SettledPrediction[];
}
