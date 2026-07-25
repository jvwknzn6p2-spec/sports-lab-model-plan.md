/**
 * Prediction Lock (Component 4).
 *
 * Runs the AI multi-agent review over each engine prediction, then freezes the
 * post-review pick into an immutable, content-hashed record. The lock is the
 * commitment point: after this, the pick is what we're graded on, and the hash
 * lets Settlement (and an auditor) detect any change to a locked record.
 *
 * The review runs *before* the lock so the locked confidence is the reviewed
 * (possibly downgraded) rank — never the raw quant rank.
 */

import { createHash } from "node:crypto";
import { reviewPrediction, HeuristicReviewProvider } from "@workspace/ai-review";
import type { GamePrediction, ReviewProvider } from "@workspace/ai-review";
import type {
  EnginePredictionsFile,
  LockFile,
  LockedPrediction,
  Picks,
} from "./types.js";

export interface LockOptions {
  provider?: ReviewProvider;
  /** Injected clock for deterministic hashing/timestamps in tests. */
  now?: Date;
}

function derivePicks(pred: GamePrediction): Picks {
  const ml = pred.model.moneyline;
  const moneyline = ml.homeWinProb >= ml.awayWinProb ? "home" : "away";
  const total = pred.model.total.overProb >= pred.model.total.underProb ? "over" : "under";
  return {
    moneyline,
    moneylineProb: moneyline === "home" ? ml.homeWinProb : ml.awayWinProb,
    total,
    totalLine: pred.model.total.line,
  };
}

/**
 * Canonical content hash over the fields that define the commitment. Built from
 * an explicit, ordered object so the hash is stable regardless of source key
 * order.
 */
function hashLock(pred: GamePrediction, finalConfidence: string, picks: Picks): string {
  const canonical = JSON.stringify({
    gameId: pred.gameId,
    moneyline: pred.model.moneyline,
    total: pred.model.total,
    runLine: pred.model.runLine,
    ev: pred.model.ev,
    finalConfidence,
    picks,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function lockPrediction(
  pred: GamePrediction,
  options: LockOptions = {},
): Promise<LockedPrediction> {
  const now = options.now ?? new Date();
  const review = await reviewPrediction(pred, { provider: options.provider, now });
  const picks = derivePicks(pred);
  return {
    gameId: pred.gameId,
    lockedAt: now.toISOString(),
    contentHash: hashLock(pred, review.finalConfidence, picks),
    prediction: pred,
    review: {
      originalConfidence: review.originalConfidence,
      finalConfidence: review.finalConfidence,
      downgraded: review.downgraded,
      warnings: review.warnings,
      flags: review.flags,
    },
    picks,
  };
}

export async function lockPredictions(
  file: EnginePredictionsFile,
  options: LockOptions = {},
): Promise<LockFile> {
  const provider = options.provider ?? new HeuristicReviewProvider();
  const now = options.now ?? new Date();
  const locked = await Promise.all(
    file.predictions.map((p) => lockPrediction(p, { provider, now })),
  );
  return {
    date: file.date,
    lockedAt: now.toISOString(),
    reviewProvider: provider.kind,
    locked,
  };
}

/** Recompute and verify a locked record's hash (tamper check). */
export function verifyLock(record: LockedPrediction): boolean {
  const expected = hashLock(
    record.prediction,
    record.review.finalConfidence,
    record.picks,
  );
  return expected === record.contentHash;
}
