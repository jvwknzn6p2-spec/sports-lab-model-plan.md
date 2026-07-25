/**
 * Risk Reviewer — the third and final reviewer in Step 9.
 *
 * "Challenges over-confident picks and can downgrade the confidence rank."
 * (plan Section 4.5). This agent is adversarial by design: it starts from the
 * assumption that a high-confidence pick must earn that confidence, and looks
 * for reasons it shouldn't. The deterministic pass encodes the objective
 * over-confidence signals (thin edge, low component agreement, coin-flip picks,
 * non-positive EV on a flagged bet); the LLM pass argues the harder cases.
 */

import type { AgentVerdict, GamePrediction, ReviewFlag } from "../types.js";
import type { ReviewProvider } from "../provider.js";
import { rankIndex } from "../confidence.js";
import {
  llmConcernsToFlags,
  llmRankToCap,
  mergeCaps,
  serializePrediction,
  worstSeverity,
} from "./shared.js";

const AGENT = "risk-reviewer" as const;
/** Below this, the model's components disagree enough to distrust an S/A pick. */
const MIN_AGREEMENT_FOR_HIGH = 0.6;
/** A "high confidence" pick needs a real edge; below this it's thin. */
const MIN_EDGE_FOR_HIGH = 0.03;
/** Moneyline gap below this is effectively a coin flip. */
const COIN_FLIP_GAP = 0.04;

export const RISK_REVIEWER_SYSTEM = `You are the Risk Reviewer for an MLB prediction system — the last check before a pick is published. Be skeptical: assume a high confidence rank (S or A) is wrong until the evidence clearly earns it. Your job is to challenge over-confidence, never to boost it.

Baseball is high-variance, and sportsbook lines are sharp, so real edges are small. Push back when:
- The model's components disagree (low component agreement) but the rank is high.
- The market edge is thin relative to the confidence claimed.
- The moneyline is close to a coin flip but the rank is better than C.
- A bet is flagged positive-EV but the edge or EV is actually near zero or negative.
- The pick depends on a single fragile assumption.

For each concern give a severity and a SCREAMING_SNAKE_CASE code. Report everything, including uncertain concerns — a later step filters. Set suggestedMaxRank to the highest rank the evidence justifies after accounting for variance: use 'B' or 'C' when the pick is over-confident, 'none' only when the confidence is genuinely earned. You may cap the rank; you may never raise it.`;

function riskRules(pred: GamePrediction): {
  flags: ReviewFlag[];
  cap: ReturnType<typeof mergeCaps>;
} {
  const flags: ReviewFlag[] = [];
  let cap: ConfidenceCap = null;

  const flag = (
    severity: ReviewFlag["severity"],
    code: string,
    message: string,
    proposedCap: ConfidenceCap,
  ): void => {
    flags.push({ agent: AGENT, severity, code, message });
    cap = mergeCaps(cap, proposedCap);
  };

  const isHigh = rankIndex(pred.confidence) <= rankIndex("A"); // S or A
  const m = pred.model;

  if (isHigh && m.componentAgreement < MIN_AGREEMENT_FOR_HIGH) {
    flag(
      "warning",
      "LOW_COMPONENT_AGREEMENT",
      `Rank ${pred.confidence} but component agreement is ${m.componentAgreement.toFixed(2)} (< ${MIN_AGREEMENT_FOR_HIGH}).`,
      "B",
    );
  }

  if (isHigh && m.marketEdge < MIN_EDGE_FOR_HIGH) {
    flag(
      "warning",
      "THIN_EDGE",
      `Rank ${pred.confidence} but market edge is only ${(m.marketEdge * 100).toFixed(1)}%.`,
      "B",
    );
  }

  const mlGap = Math.abs(m.moneyline.homeWinProb - m.moneyline.awayWinProb);
  if (mlGap < COIN_FLIP_GAP && rankIndex(pred.confidence) < rankIndex("C")) {
    flag(
      "warning",
      "COIN_FLIP",
      `Moneyline is near a coin flip (${(mlGap * 100).toFixed(1)}% gap) but rank is ${pred.confidence}.`,
      "C",
    );
  }

  for (const bet of m.ev.bets) {
    if (bet.positive && (bet.edge <= 0 || bet.evPer1Unit <= 0)) {
      flag(
        "warning",
        "EV_NOT_POSITIVE",
        `Bet "${bet.selection}" is flagged positive-EV but edge=${(bet.edge * 100).toFixed(1)}%, EV=${bet.evPer1Unit.toFixed(3)}.`,
        "B",
      );
    }
  }

  return { flags, cap };
}

type ConfidenceCap = ReturnType<typeof mergeCaps>;

export async function reviewRiskReviewer(
  pred: GamePrediction,
  provider: ReviewProvider,
): Promise<AgentVerdict> {
  const { flags: heuristicFlags, cap: heuristicCap } = riskRules(pred);
  let cap = heuristicCap;
  const flags: ReviewFlag[] = [...heuristicFlags];
  let reasoning = "";
  let source: AgentVerdict["source"] = "heuristic";

  if (provider.available) {
    const outcome = await provider.reason({
      system: RISK_REVIEWER_SYSTEM,
      context: serializePrediction(pred),
    });
    if (outcome.ok && outcome.verdict) {
      flags.push(...llmConcernsToFlags(AGENT, outcome.verdict));
      cap = mergeCaps(cap, llmRankToCap(outcome.verdict.suggestedMaxRank));
      reasoning = outcome.verdict.overallAssessment;
      source = "heuristic+llm";
    } else {
      reasoning = `LLM review unavailable (${outcome.note}); deterministic risk checks only.`;
    }
  } else {
    reasoning = "Deterministic risk checks only (no LLM provider).";
  }

  const worst = worstSeverity(flags);
  return {
    agent: AGENT,
    ok: worst === null || worst === "info",
    flags,
    suggestedMaxRank: cap,
    reasoning,
    source,
  };
}
