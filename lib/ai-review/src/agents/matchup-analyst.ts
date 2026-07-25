/**
 * Matchup Analyst — the second reviewer in Step 9.
 *
 * "Reviews the pick against qualitative context (injury news, pitcher trends)."
 * (plan Section 4.5). This is the agent whose value is mostly qualitative, so
 * it is LLM-first: the model reads injuries, weather, and narrative factors
 * against the model's pick. A thin deterministic pass provides guardrails for
 * the two cases that are objective enough to catch without a model — a key
 * injury on the side being picked, and weather that plainly contradicts the
 * total pick.
 */

import type { AgentVerdict, GamePrediction, ReviewFlag, Side } from "../types.js";
import type { ReviewProvider } from "../provider.js";
import {
  capForSeverity,
  llmConcernsToFlags,
  llmRankToCap,
  mergeCaps,
  serializePrediction,
  worstSeverity,
} from "./shared.js";

const AGENT = "matchup-analyst" as const;
/** A moneyline lean this strong is "the pick leans on that team". */
const STRONG_LEAN_PROB = 0.58;
/** Wind at or above this is a meaningful push on run totals. */
const STRONG_WIND_MPH = 12;

export const MATCHUP_ANALYST_SYSTEM = `You are the Matchup Analyst for an MLB prediction system. You review a completed prediction against qualitative context to catch things the statistical model does not capture. You do NOT recompute the model or invent probabilities.

Consider:
- Injuries: does a key hitter or the listed starter being out/questionable undercut the side the model is picking?
- Pitcher trends and matchup shape: does the pick lean heavily on a starter whose season line may not reflect current form?
- Weather vs the total: wind blowing out and warm temps push run totals UP; wind blowing in and cold push them DOWN. Does the total pick fight the weather?
- Park and lineup context that the narrative factors hint at.

For each concern, give a severity and a SCREAMING_SNAKE_CASE code. Report everything you notice, including low-confidence observations — a later step filters. Set suggestedMaxRank to the best rank the matchup context supports: 'B' when real qualitative risk exists, 'C' when the context seriously undermines the pick, otherwise 'none'. If the qualitative picture supports the pick, say so and use 'none'.`;

/** The moneyline side the model is picking, or null if it's a coin flip. */
function pickedSide(pred: GamePrediction): Side | null {
  const { homeWinProb, awayWinProb } = pred.model.moneyline;
  if (Math.abs(homeWinProb - awayWinProb) < 0.02) return null;
  return homeWinProb > awayWinProb ? "home" : "away";
}

function matchupRules(pred: GamePrediction): {
  flags: ReviewFlag[];
  cap: ReturnType<typeof capForSeverity>;
} {
  const flags: ReviewFlag[] = [];
  let cap: ReturnType<typeof capForSeverity> = null;

  const flag = (
    severity: ReviewFlag["severity"],
    code: string,
    message: string,
  ): void => {
    flags.push({ agent: AGENT, severity, code, message });
    cap = mergeCaps(cap, capForSeverity(severity));
  };

  // Key injury on the side we're picking.
  const side = pickedSide(pred);
  const lean =
    side === "home"
      ? pred.model.moneyline.homeWinProb
      : side === "away"
        ? pred.model.moneyline.awayWinProb
        : 0;
  if (side !== null && lean >= STRONG_LEAN_PROB) {
    for (const injury of pred.data.injuries) {
      if (injury.team === side && injury.keyPlayer && injury.status !== "day-to-day") {
        flag(
          "warning",
          "KEY_INJURY_ON_PICK",
          `Pick leans ${(lean * 100).toFixed(0)}% on the ${side} team, but key player ${injury.player} is ${injury.status}.`,
        );
      }
    }
  }

  // Weather contradicting the total pick.
  const weather = pred.data.weather;
  const total = pred.model.total;
  if (weather && weather.windMph >= STRONG_WIND_MPH) {
    const leansOver = total.overProb > total.underProb;
    if (leansOver && weather.windDir === "in") {
      flag(
        "warning",
        "WEATHER_CONTRA_TOTAL",
        `Total leans OVER but wind is blowing in at ${weather.windMph} mph, which suppresses runs.`,
      );
    } else if (!leansOver && weather.windDir === "out") {
      flag(
        "warning",
        "WEATHER_CONTRA_TOTAL",
        `Total leans UNDER but wind is blowing out at ${weather.windMph} mph, which inflates runs.`,
      );
    }
  }

  return { flags, cap };
}

export async function reviewMatchupAnalyst(
  pred: GamePrediction,
  provider: ReviewProvider,
): Promise<AgentVerdict> {
  const { flags: heuristicFlags, cap: heuristicCap } = matchupRules(pred);
  let cap = heuristicCap;
  const flags: ReviewFlag[] = [...heuristicFlags];
  let reasoning = "";
  let source: AgentVerdict["source"] = "heuristic";

  if (provider.available) {
    const outcome = await provider.reason({
      system: MATCHUP_ANALYST_SYSTEM,
      context: serializePrediction(pred),
    });
    if (outcome.ok && outcome.verdict) {
      flags.push(...llmConcernsToFlags(AGENT, outcome.verdict));
      cap = mergeCaps(cap, llmRankToCap(outcome.verdict.suggestedMaxRank));
      reasoning = outcome.verdict.overallAssessment;
      source = "heuristic+llm";
    } else {
      reasoning = `LLM review unavailable (${outcome.note}); deterministic matchup checks only.`;
    }
  } else {
    reasoning =
      "Deterministic matchup checks only (no LLM provider); qualitative review skipped.";
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
