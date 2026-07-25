/**
 * Step 7: the S/A/B/C confidence rank.
 *
 * The rank answers one question: how much should a reader trust this pick? It
 * is built from four components and then *capped* by data problems, because a
 * large edge computed from incomplete inputs is not a high-confidence pick — it
 * is usually a bug.
 *
 * Components
 *   edge       — size of the model's edge over the vig-free market price
 *   data       — completeness of the inputs (from validate.ts)
 *   agreement  — do the model's two independent offense estimates agree?
 *   precision  — is the edge larger than the simulation's own noise?
 *
 * Caps, applied after scoring, each of which can only lower the rank:
 *   - no market prices          -> at best B (an unverifiable edge)
 *   - a critical input missing  -> C
 *   - an unannounced starter    -> at best A (both unannounced -> B)
 *   - uncalibrated model        -> at best A (nothing has been scored yet)
 *   - already-final game        -> at best B (season stats contain the result)
 */

import { MLB_CONSTANTS, type ModelConstants } from "../config";
import { clamp } from "../core/math";
import type {
  BetEvaluation,
  Calibration,
  ConfidenceAssessment,
  ConfidenceRank,
  DataQuality,
  GameContext,
  SimulationResult,
  Side,
} from "../core/types";
import { componentRunsPerGame } from "./baseline";

const RANK_ORDER: ConfidenceRank[] = ["S", "A", "B", "C"];

function lower(rank: ConfidenceRank, cap: ConfidenceRank): ConfidenceRank {
  return RANK_ORDER.indexOf(rank) >= RANK_ORDER.indexOf(cap) ? rank : cap;
}

/**
 * Mean disagreement in runs/game between a team's raw runs scored and the
 * estimate implied by its OBP and SLG. A large gap means the offense has been
 * scoring above or below what its component stats support — a sequencing or
 * schedule artefact, and a reason to trust the projection less.
 */
export function offenseEstimatorSpread(
  context: GameContext,
  constants: ModelConstants,
): number | null {
  const gaps: number[] = [];
  for (const side of ["home", "away"] as Side[]) {
    const offense = context.teams[side].offense;
    if (!offense || offense.runsPerGame === null) continue;
    if (offense.onBasePct === null || offense.sluggingPct === null) continue;
    const component = componentRunsPerGame(offense.onBasePct, offense.sluggingPct, constants);
    gaps.push(Math.abs(offense.runsPerGame - component));
  }
  if (gaps.length === 0) return null;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

export interface ConfidenceInput {
  context: GameContext;
  quality: DataQuality;
  simulation: SimulationResult;
  bets: BetEvaluation[];
  calibration: Calibration;
  constants?: ModelConstants;
}

export function assessConfidence(input: ConfidenceInput): ConfidenceAssessment {
  const constants = input.constants ?? MLB_CONSTANTS;
  const notes: string[] = [];
  const caps: string[] = [];

  // --- edge -----------------------------------------------------------------
  const bestEdge = input.bets.reduce(
    (best, bet) => (bet.expectedValue > 0 && bet.edge > best ? bet.edge : best),
    0,
  );
  // An 8-point edge is exceptional in a market this sharp; treat it as the top
  // of the scale rather than pretending 30-point edges are real.
  const edgeScore = 100 * clamp(bestEdge / 0.08, 0, 1);
  if (input.bets.length > 0) {
    notes.push(`best edge ${(bestEdge * 100).toFixed(1)} points vs the de-vigged line`);
  }

  // --- data -----------------------------------------------------------------
  const dataScore = 100 * clamp(input.quality.completeness, 0, 1);

  // --- agreement ------------------------------------------------------------
  const spread = offenseEstimatorSpread(input.context, constants);
  const agreementScore =
    spread === null ? 50 : 100 * clamp(1 - spread / 1.5, 0, 1);
  if (spread !== null && spread > 0.6) {
    notes.push(
      `offense estimates disagree by ${spread.toFixed(2)} R/G (runs scored vs OBP/SLG)`,
    );
  }

  // --- precision ------------------------------------------------------------
  const noise = 2 * input.simulation.winProbStdError;
  const precisionScore =
    bestEdge > 0 ? 100 * clamp(1 - noise / Math.max(bestEdge, 0.005), 0, 1) : 50;

  const score =
    0.4 * edgeScore + 0.3 * dataScore + 0.15 * agreementScore + 0.15 * precisionScore;

  const thresholds = input.calibration.confidenceThresholds;
  let rank: ConfidenceRank =
    score >= thresholds.S ? "S" : score >= thresholds.A ? "A" : score >= thresholds.B ? "B" : "C";

  // --- caps -----------------------------------------------------------------
  if (!input.quality.usable) {
    rank = "C";
    caps.push("a critical input is missing — informational only");
  }
  if (input.bets.length === 0) {
    rank = lower(rank, "B");
    caps.push("no market prices, so the edge cannot be verified");
  }
  if (input.quality.errorCount > 0) {
    rank = lower(rank, "B");
    caps.push(`${input.quality.errorCount} data error(s) during collection`);
  }

  const unannounced = (["home", "away"] as Side[]).filter(
    (side) => input.context.teams[side].starter === null,
  );
  if (unannounced.length === 1) {
    rank = lower(rank, "A");
    caps.push(`${unannounced[0]} starter unannounced or unrated`);
  } else if (unannounced.length === 2) {
    rank = lower(rank, "B");
    caps.push("neither starter is announced or rated");
  }

  if (!input.context.park.matched) {
    rank = lower(rank, "A");
    caps.push("ballpark not in the park-factor table");
  }
  if (input.context.weather === null) {
    rank = lower(rank, "A");
    caps.push("no first-pitch weather");
  }

  if (input.calibration.sampleGames === 0) {
    rank = lower(rank, "A");
    caps.push(
      "model has never been scored against results — no S ranks until calibration has data",
    );
  }

  if (input.context.issues.some((issue) => issue.code === "retroactive_prediction")) {
    rank = lower(rank, "B");
    caps.push("game already started or finished when inputs were pulled");
  }

  return {
    rank,
    score,
    components: { edgeScore, dataScore, agreementScore, precisionScore },
    caps,
    notes,
  };
}
