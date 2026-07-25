/**
 * Step 7 — Confidence ranking (S / A / B / C).
 *
 * The single letter that tells a beginner which picks to pay attention to.
 * Per plan Section 2 it combines three things:
 *
 *   (a) the size of the model's edge over the market   → the starting tier
 *   (b) data completeness                              → a hard ceiling
 *   (c) how much the model's components agree          → penalties
 *
 * The rank describes **the recommended bet**, not the game. A game with clean
 * data but no edge is a C: there is nothing to act on, which is exactly what
 * "informational only" means in the plan.
 *
 * Two design commitments worth stating plainly:
 *
 * - **Bigger is not always better.** A double-digit edge lowers the rank
 *   rather than raising it. Sportsbook lines are sharp (plan Section 7), so an
 *   edge that large is more often a stale line or a bad input than a genuine
 *   opportunity. Treating it as our best bet is how a data bug becomes a
 *   confident recommendation.
 *
 * - **Data quality is a ceiling, never a bonus.** Step 3's `confidenceCap` can
 *   only ever lower the rank. Perfect data does not promote a weak edge.
 */
import { lowerRank, minRank } from "./flags";
import type { ConfidenceRank } from "./schemas";
import type { ValidationResult } from "./validate";
import type { BaselineResult } from "./model/baseline";
import type { SimulationResult } from "./model/simulate";
import type { BetEvaluation, GameEvaluation } from "./odds/ev";
import {
  CONFIDENCE_EDGE_A,
  CONFIDENCE_EDGE_B,
  CONFIDENCE_EDGE_S,
  FORM_DISAGREEMENT_TOLERANCE,
  IMPLAUSIBLE_EDGE,
  MIN_EDGE_TO_NOISE_RATIO,
} from "./model/constants";

/** How a single factor affected the rank. */
export type FactorImpact = "supports" | "neutral" | "penalty";

export interface ConfidenceFactor {
  /** Short name, e.g. "Edge size" or "Simulation noise". */
  label: string;
  /** Report-ready explanation of what was found. */
  detail: string;
  impact: FactorImpact;
  /** Rank steps deducted. Zero unless `impact` is "penalty". */
  steps: number;
}

export interface ConfidenceAssessment {
  gameId: string;
  /** The final rank, after penalties and the data-quality ceiling. */
  rank: ConfidenceRank;
  /** The rank the edge alone would have earned, before penalties. */
  baseRank: ConfidenceRank;
  /** After penalties but before the data ceiling was applied. */
  rankBeforeCap: ConfidenceRank;
  /** Step 3's ceiling. The final rank can never beat this. */
  dataCap: ConfidenceRank;
  /** The bet this rank describes. Null when nothing cleared the edge bar. */
  primaryBet: BetEvaluation | null;
  /** Every factor considered, in the order they were applied. */
  factors: ConfidenceFactor[];
}

export interface ConfidenceInputs {
  validation: ValidationResult;
  baseline: BaselineResult;
  simulation: SimulationResult;
  evaluation: GameEvaluation;
}

/** Monte Carlo standard error of a simulated proportion. */
function standardError(probability: number, iterations: number): number {
  return Math.sqrt((probability * (1 - probability)) / iterations);
}

/** The starting tier implied by the edge alone. */
function tierFromEdge(edge: number): ConfidenceRank {
  if (edge >= CONFIDENCE_EDGE_S) return "S";
  if (edge >= CONFIDENCE_EDGE_A) return "A";
  if (edge >= CONFIDENCE_EDGE_B) return "B";
  return "C";
}

/**
 * Which side of the game a bet backs, or null for bets that are not about a
 * team winning (totals).
 */
function backedSide(bet: BetEvaluation): "home" | "away" | null {
  if (bet.market === "total") return null;
  return bet.selection === "home" ? "home" : "away";
}

/** How recent form relates to the side being backed. */
type FormVerdict = "unknown" | "supports" | "neutral" | "contradicts";

/**
 * Does recent form support backing this side? Reads the baseline's recorded
 * "Recent form" step for that team — a multiplier above 1 means the team has
 * been outscoring its season rate.
 *
 * A deadband of {@link FORM_DISAGREEMENT_TOLERANCE} around neutral keeps a
 * fraction-of-a-percent wobble from counting as genuine disagreement.
 */
function recentFormVerdict(
  baseline: BaselineResult,
  side: "home" | "away",
): { verdict: FormVerdict; multiplier: number } {
  const estimate = side === "home" ? baseline.home : baseline.away;
  const step = estimate.steps.find((s) => s.label === "Recent form");
  if (step === undefined || !step.applied) return { verdict: "unknown", multiplier: 1 };

  const deviation = step.multiplier - 1;
  if (deviation > FORM_DISAGREEMENT_TOLERANCE) {
    return { verdict: "supports", multiplier: step.multiplier };
  }
  if (deviation < -FORM_DISAGREEMENT_TOLERANCE) {
    return { verdict: "contradicts", multiplier: step.multiplier };
  }
  return { verdict: "neutral", multiplier: step.multiplier };
}

/**
 * Assign the S/A/B/C confidence rank for one game.
 *
 * @param inputs Outputs of Steps 3–6 for the same game.
 */
export function assignConfidence(inputs: ConfidenceInputs): ConfidenceAssessment {
  const { validation, baseline, simulation, evaluation } = inputs;
  const factors: ConfidenceFactor[] = [];
  const dataCap = validation.confidenceCap;

  /* --- No edge: informational only --------------------------------------- */
  const primaryBet = evaluation.valueBets[0] ?? null;
  if (primaryBet === null) {
    factors.push({
      label: "Edge size",
      detail:
        evaluation.bets.length === 0
          ? "No markets were priced, so there is nothing to recommend."
          : "No bet cleared the minimum edge — the model agrees with the market.",
      impact: "penalty",
      steps: 0,
    });
    const rank = minRank("C", dataCap);
    if (dataCap !== "S") {
      factors.push({
        label: "Data quality",
        detail: `Step 3 capped this game at ${dataCap}.`,
        impact: "penalty",
        steps: 0,
      });
    }
    return {
      gameId: validation.gameId,
      rank,
      baseRank: "C",
      rankBeforeCap: "C",
      dataCap,
      primaryBet: null,
      factors,
    };
  }

  /* --- (a) Edge size sets the starting tier ------------------------------- */
  const edge = primaryBet.edge;
  const baseRank = tierFromEdge(edge);
  factors.push({
    label: "Edge size",
    detail:
      `${primaryBet.label} carries a ${(edge * 100).toFixed(1)}% edge over the ` +
      `de-vigged market — a starting tier of ${baseRank}.`,
    impact: "supports",
    steps: 0,
  });

  let rank = baseRank;
  const penalise = (label: string, detail: string, steps: number) => {
    factors.push({ label, detail, impact: "penalty", steps });
    rank = lowerRank(rank, steps);
  };

  /* --- (c) Component agreement -------------------------------------------- */

  // An edge this large is a warning sign, not a green light.
  if (edge >= IMPLAUSIBLE_EDGE) {
    penalise(
      "Implausible edge",
      `A ${(edge * 100).toFixed(1)}% edge is larger than sharp markets usually allow; ` +
        "more often a stale line or a bad input than a real opportunity.",
      1,
    );
  }

  // Is the edge bigger than the simulation's own noise?
  const se = standardError(primaryBet.modelProbabilityNoPush, simulation.iterations);
  const noiseRatio = se > 0 ? edge / se : Number.POSITIVE_INFINITY;
  if (noiseRatio < MIN_EDGE_TO_NOISE_RATIO) {
    penalise(
      "Simulation noise",
      `The edge is only ${noiseRatio.toFixed(1)}× the simulation's standard error ` +
        `(${simulation.iterations} iterations); it may be noise rather than signal.`,
      1,
    );
  } else {
    factors.push({
      label: "Simulation noise",
      detail: `The edge is ${noiseRatio.toFixed(1)}× the simulation's standard error.`,
      impact: "supports",
      steps: 0,
    });
  }

  // Consistency guard: the simulation is derived from the baseline, so these
  // must point the same way. If they ever diverge, something is broken and the
  // pick should not be trusted at all.
  const baselineFavoursHome = baseline.expectedMargin > 0;
  const simulationFavoursHome = simulation.moneyline.home > 0.5;
  if (baseline.expectedMargin !== 0 && baselineFavoursHome !== simulationFavoursHome) {
    penalise(
      "Component disagreement",
      "The baseline model and the simulation favour different teams — " +
        "an internal inconsistency, so this pick cannot be trusted.",
      2,
    );
  }

  // Does recent form back the team being backed?
  const side = backedSide(primaryBet);
  if (side !== null) {
    const form = recentFormVerdict(baseline, side);
    const pct = `${((form.multiplier - 1) * 100).toFixed(1)}%`;
    switch (form.verdict) {
      case "unknown":
        factors.push({
          label: "Recent form",
          detail: "No recent-form data for the backed team — no corroboration either way.",
          impact: "neutral",
          steps: 0,
        });
        break;
      case "supports":
        factors.push({
          label: "Recent form",
          detail: `Recent form backs the ${side} team (${pct}).`,
          impact: "supports",
          steps: 0,
        });
        break;
      case "neutral":
        factors.push({
          label: "Recent form",
          detail: `Recent form is flat for the ${side} team (${pct}) — neither confirms nor contradicts.`,
          impact: "neutral",
          steps: 0,
        });
        break;
      case "contradicts":
        penalise(
          "Recent form",
          `Recent form runs against the ${side} team (${pct}), so the components disagree.`,
          1,
        );
        break;
    }
  }

  // A totals bet leans on weather, and a forecast is an estimate of an
  // estimate — the observed-vs-forecast distinction, applied to confidence.
  if (primaryBet.market === "total" && baseline.weatherMode === "forecast" && baseline.weatherApplied) {
    penalise(
      "Forecast weather",
      "This total depends on forecast weather rather than an observed reading; " +
        "conditions at first pitch may differ.",
      1,
    );
  }

  const rankBeforeCap = rank;

  /* --- (b) Data completeness is a ceiling, never a bonus ------------------ */
  const finalRank = minRank(rankBeforeCap, dataCap);
  if (finalRank !== rankBeforeCap) {
    factors.push({
      label: "Data quality",
      detail:
        `Step 3 capped this game at ${dataCap} (completeness ` +
        `${Math.round(validation.completeness * 100)}%), lowering it from ${rankBeforeCap}.`,
      impact: "penalty",
      steps: 0,
    });
  } else if (dataCap === "S") {
    factors.push({
      label: "Data quality",
      detail: "All required inputs present and current.",
      impact: "supports",
      steps: 0,
    });
  }

  return {
    gameId: validation.gameId,
    rank: finalRank,
    baseRank,
    rankBeforeCap,
    dataCap,
    primaryBet,
    factors,
  };
}

/** Rank a batch of games and sort them best-first, as the daily summary does. */
export function rankGames(entries: readonly ConfidenceInputs[]): ConfidenceAssessment[] {
  const order: Record<ConfidenceRank, number> = { S: 0, A: 1, B: 2, C: 3 };
  return entries
    .map(assignConfidence)
    .sort((a, b) => {
      const byRank = order[a.rank] - order[b.rank];
      if (byRank !== 0) return byRank;
      // Within a rank, the bigger edge leads.
      return (b.primaryBet?.edge ?? -1) - (a.primaryBet?.edge ?? -1);
    });
}

/** Render the confidence reasoning for the daily report. */
export function explainConfidence(assessment: ConfidenceAssessment): string[] {
  const marks: Record<FactorImpact, string> = {
    supports: "+",
    neutral: "·",
    penalty: "−",
  };
  const header = assessment.primaryBet
    ? `Confidence: ${assessment.rank}  (${assessment.primaryBet.label})`
    : `Confidence: ${assessment.rank}  (no recommended bet)`;

  return [
    header,
    ...assessment.factors.map((f) => {
      const steps = f.steps > 0 ? ` [-${f.steps}]` : "";
      return `  ${marks[f.impact]} ${f.label}${steps}: ${f.detail}`;
    }),
  ];
}
