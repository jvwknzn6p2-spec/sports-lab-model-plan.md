/**
 * Step 9 — Running the review and applying its verdicts.
 *
 * The plan's constraint (Section 4.5) is that the AI review can lower
 * confidence or add warnings, but the numbers still come from the statistical
 * model and the simulation. This module enforces that three ways:
 *
 *  1. **Structurally.** {@link ReviewOutcome} carries a rank and warnings and
 *     nothing else. There is no field on it through which a probability, an
 *     expected-runs figure, or an EV number could be changed — the review
 *     cannot touch them because it has nowhere to put them.
 *  2. **In the schema.** `confidenceDelta` is non-negative, so no verdict can
 *     express a promotion (see `schemas.ts`).
 *  3. **In code.** {@link applyReview} clamps each delta and asserts the result
 *     never outranks the input, belt-and-braces against a hand-built verdict.
 */
import { lowerRank, minRank, CONFIDENCE_ORDER } from "../flags";
import type { ConfidenceRank } from "../schemas";
import type { ConfidenceAssessment } from "../confidence";
import { buildDossier, type DossierInputs } from "./prompts";
import { ruleBasedReviewer, ReviewError, type Reviewer } from "./reviewers";
import type { ReviewAgent, ReviewVerdict } from "./schemas";

/** The three reviewers, in the order the plan introduces them. */
export const REVIEW_AGENTS: readonly ReviewAgent[] = [
  "data-auditor",
  "matchup-analyst",
  "risk-reviewer",
] as const;

export interface ReviewFailure {
  agent: ReviewAgent;
  message: string;
}

export interface ReviewOutcome {
  gameId: string;
  /** True when at least one reviewer returned a verdict. */
  reviewed: boolean;
  /** Why the review was skipped, or null when it ran. */
  skippedReason: string | null;
  verdicts: ReviewVerdict[];
  /** Reviewers that errored. Recorded, never silently dropped. */
  failures: ReviewFailure[];
  /** The rank the statistical layer produced. */
  rankBefore: ConfidenceRank;
  /** The rank after review. Never better than `rankBefore`. */
  rank: ConfidenceRank;
  /**
   * Total ranks the review dropped. Positive means dropped, matching the sign
   * convention on a verdict's `confidenceDelta`; zero means unchanged. It can
   * never be negative — this layer does not promote.
   */
  confidenceDelta: number;
  /** Deduplicated warnings from every reviewer, for the report card. */
  warnings: string[];
  /** True when any reviewer returned "reject". */
  rejected: boolean;
}

/**
 * Fold verdicts into a final rank.
 *
 * A `reject` from any reviewer floors the rank at C — one reviewer saying "do
 * not act on this" is not something the other two should be able to average
 * away. Otherwise deltas **sum**: the three agents have disjoint remits (data
 * integrity, baseball matchup, risk calibration), so two of them finding
 * independent problems is worse than either alone.
 *
 * Pure and synchronous — testable without touching the network.
 */
export function applyReview(
  rankBefore: ConfidenceRank,
  verdicts: readonly ReviewVerdict[],
): { rank: ConfidenceRank; confidenceDelta: number; warnings: string[]; rejected: boolean } {
  const rejected = verdicts.some((v) => v.assessment === "reject");

  // Clamp defensively: the schema forbids negatives, but a verdict built by
  // hand rather than parsed could still carry one, and a negative delta would
  // silently promote the pick — the one thing this layer must never do.
  const totalDelta = verdicts.reduce((sum, v) => sum + Math.max(0, Math.trunc(v.confidenceDelta)), 0);

  const rank = rejected ? "C" : lowerRank(rankBefore, totalDelta);

  // The review can only lower. If anything above ever produced a better rank,
  // take the worse of the two rather than trusting it.
  const safeRank = minRank(rankBefore, rank);

  const warnings = [...new Set(verdicts.flatMap((v) => v.warnings))];

  return {
    rank: safeRank,
    confidenceDelta: CONFIDENCE_ORDER.indexOf(safeRank) - CONFIDENCE_ORDER.indexOf(rankBefore),
    warnings,
    rejected,
  };
}

export interface ReviewOptions {
  /** Backend to use. Defaults to the deterministic reviewer. */
  reviewer?: Reviewer;
  /** Which agents to run. Defaults to all three. */
  agents?: readonly ReviewAgent[];
  /**
   * Review games that carry no recommended bet. Off by default.
   *
   * This is the single biggest cost lever in the layer: most games on a slate
   * produce no value bet, and a pick nobody is being asked to act on has
   * nothing for a reviewer to protect against. Turn it on only when auditing
   * the pipeline itself.
   */
  reviewGamesWithoutBets?: boolean;
}

/**
 * Run the multi-agent review for one game.
 *
 * Agents run concurrently and independently. A reviewer that fails is recorded
 * in `failures` and the others still count — a flaky API call should degrade
 * the review, not delete it.
 *
 * @param inputs Outputs of Steps 3–7 for the game under review.
 */
export async function reviewGame(
  inputs: DossierInputs,
  options: ReviewOptions = {},
): Promise<ReviewOutcome> {
  const reviewer = options.reviewer ?? ruleBasedReviewer;
  const agents = options.agents ?? REVIEW_AGENTS;
  const confidence: ConfidenceAssessment = inputs.confidence;
  const rankBefore = confidence.rank;

  const base = {
    gameId: confidence.gameId,
    rankBefore,
    rank: rankBefore,
    confidenceDelta: 0,
    verdicts: [] as ReviewVerdict[],
    failures: [] as ReviewFailure[],
    warnings: [] as string[],
    rejected: false,
  };

  if (confidence.primaryBet === null && options.reviewGamesWithoutBets !== true) {
    return {
      ...base,
      reviewed: false,
      skippedReason: "No recommended bet — nothing to review.",
    };
  }

  const dossier = buildDossier(inputs);

  const settled = await Promise.all(
    agents.map(async (agent): Promise<ReviewVerdict | ReviewFailure> => {
      try {
        return await reviewer(agent, dossier);
      } catch (error) {
        const message =
          error instanceof ReviewError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return { agent, message };
      }
    }),
  );

  const verdicts = settled.filter((r): r is ReviewVerdict => "assessment" in r);
  const failures = settled.filter((r): r is ReviewFailure => !("assessment" in r));

  const applied = applyReview(rankBefore, verdicts);

  // A reviewer that failed to run is surfaced rather than quietly ignored — the
  // reader should know the pick got less scrutiny than the label implies. It
  // does not change the rank: an absent opinion is not evidence against a pick.
  const warnings = [
    ...applied.warnings,
    ...failures.map((f) => `Review incomplete: ${f.agent} did not return a verdict.`),
  ];

  return {
    gameId: confidence.gameId,
    reviewed: verdicts.length > 0,
    skippedReason: null,
    verdicts,
    failures,
    rankBefore,
    rank: applied.rank,
    confidenceDelta: applied.confidenceDelta,
    warnings,
    rejected: applied.rejected,
  };
}

/** Render the review for the daily report card. */
export function explainReview(outcome: ReviewOutcome): string[] {
  if (outcome.skippedReason !== null) {
    return [`AI review:   skipped — ${outcome.skippedReason}`];
  }

  const header =
    outcome.rank === outcome.rankBefore
      ? `AI review:   ${outcome.rankBefore} confirmed`
      : `AI review:   ${outcome.rankBefore} → ${outcome.rank}` +
        (outcome.rejected ? "  (REJECTED)" : "");

  const marks: Record<ReviewVerdict["assessment"], string> = {
    endorse: "+",
    caution: "·",
    reject: "✗",
  };

  return [
    header,
    ...outcome.verdicts.map((v) => {
      const drop = v.confidenceDelta > 0 ? ` [-${v.confidenceDelta}]` : "";
      return `  ${marks[v.assessment]} ${v.agent}${drop}: ${v.reasoning}`;
    }),
    ...outcome.failures.map((f) => `  ! ${f.agent}: ${f.message}`),
    ...outcome.warnings.map((w) => `  ⚠ ${w}`),
  ];
}
