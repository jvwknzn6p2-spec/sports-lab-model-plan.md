/**
 * Data Auditor — the first reviewer in Step 9.
 *
 * "Confirms inputs are present and reasonable; flags stale or missing data."
 * (plan Section 4.5). This agent is deliberately deterministic-heavy: data
 * completeness and probability sanity are objective, so the guardrail pass does
 * most of the work and cannot be talked out of a critical flag by the model.
 * The optional LLM pass adds reasonableness judgment (e.g. spotting implausible
 * stat combinations that the fixed thresholds miss).
 */

import type { AgentVerdict, GamePrediction, ReviewFlag } from "../types.js";
import type { ReviewProvider } from "../provider.js";
import {
  capForSeverity,
  llmConcernsToFlags,
  llmRankToCap,
  mergeCaps,
  serializePrediction,
  worstSeverity,
} from "./shared.js";

const AGENT = "data-auditor" as const;
const DEFAULT_STALE_MINUTES = 240;
/** Probabilities in a complementary pair should sum to ~1. */
const PROB_SUM_TOLERANCE = 0.02;

export const DATA_AUDITOR_SYSTEM = `You are the Data Auditor for an MLB prediction system. Your only job is to judge whether the DATA behind a prediction is present, fresh, and internally consistent — not whether the pick is good.

Focus on:
- Missing or unconfirmed starting pitchers (the single biggest source of blown predictions).
- Missing betting odds (without them, expected value is meaningless).
- Missing team batting, bullpen, weather, or park data.
- Stale data (fetched long before first pitch).
- Implausible stat combinations that suggest a bad feed (e.g. an ERA of 0.00 over many innings, negative rates, a WHIP wildly out of line with the ERA).
- Probabilities that don't add up (a complementary pair that doesn't sum to ~1).

Report every concern you find with a severity and a SCREAMING_SNAKE_CASE code, even low-severity ones — a later step filters. Do not invent numbers or re-estimate the model. Set suggestedMaxRank to the best confidence rank the data quality can justify: 'C' if the data is unreliable enough that the pick is informational only, 'B' if there is a real gap but the pick still has substance, otherwise 'none'.`;

/** Run the deterministic guardrail pass. Returns flags + a suggested cap. */
function auditRules(
  pred: GamePrediction,
  now: Date,
): { flags: ReviewFlag[]; cap: ReturnType<typeof capForSeverity> } {
  const flags: ReviewFlag[] = [];
  const d = pred.data;
  let cap: ReturnType<typeof capForSeverity> = null;

  const flag = (
    severity: ReviewFlag["severity"],
    code: string,
    message: string,
    explicitCap?: ReturnType<typeof capForSeverity>,
  ): void => {
    flags.push({ agent: AGENT, severity, code, message });
    cap = mergeCaps(cap, explicitCap ?? capForSeverity(severity));
  };

  if (!d.scheduleConfirmed) {
    flag("critical", "SCHEDULE_UNCONFIRMED", "Game schedule/time is not confirmed.");
  }

  // Starting pitchers: missing object vs present-but-unconfirmed.
  for (const [side, pitcher] of [
    ["home", d.homePitcher],
    ["away", d.awayPitcher],
  ] as const) {
    if (pitcher === null) {
      flag(
        "critical",
        "MISSING_STARTER",
        `No starting pitcher listed for the ${side} team.`,
      );
    } else if (!pitcher.confirmed) {
      flag(
        "critical",
        "UNCONFIRMED_STARTER",
        `${side} starter ${pitcher.name} is projected, not confirmed.`,
      );
    } else {
      // Sanity checks on a confirmed pitcher's line.
      if (
        pitcher.era < 0 ||
        pitcher.era > 15 ||
        pitcher.whip < 0 ||
        pitcher.whip > 3 ||
        pitcher.kPer9 < 0
      ) {
        flag(
          "warning",
          "IMPLAUSIBLE_STAT",
          `${side} starter ${pitcher.name} has out-of-range stats (ERA ${pitcher.era}, WHIP ${pitcher.whip}).`,
        );
      }
      if (pitcher.era === 0 && pitcher.inningsPitched > 20) {
        flag(
          "warning",
          "IMPLAUSIBLE_STAT",
          `${side} starter ${pitcher.name} shows a 0.00 ERA over ${pitcher.inningsPitched} IP — likely a stale or bad feed.`,
        );
      }
    }
  }

  if (!d.oddsAvailable) {
    flag(
      "critical",
      "MISSING_ODDS",
      "No betting odds available — expected value cannot be computed.",
    );
  }
  if (!d.battingStatsAvailable) {
    flag("warning", "MISSING_BATTING", "Team batting stats are missing.");
  }
  if (!d.bullpenStatsAvailable) {
    flag("warning", "MISSING_BULLPEN", "Bullpen stats are missing.");
  }
  if (d.weather === null) {
    flag("warning", "MISSING_WEATHER", "Weather data is missing (affects totals).");
  }
  if (!d.parkFactorsAvailable) {
    flag("info", "MISSING_PARK_FACTORS", "Park-factor data is missing.");
  }
  if (!d.recentFormAvailable) {
    flag("info", "MISSING_RECENT_FORM", "Recent-form data is missing.");
  }

  // Staleness.
  const fetchedAt = Date.parse(d.fetchedAt);
  if (Number.isNaN(fetchedAt)) {
    flag("warning", "BAD_FETCH_TIMESTAMP", "Data fetch timestamp is unparseable.");
  } else {
    const ageMinutes = (now.getTime() - fetchedAt) / 60000;
    const budget = d.staleAfterMinutes ?? DEFAULT_STALE_MINUTES;
    if (ageMinutes > budget) {
      flag(
        "warning",
        "STALE_DATA",
        `Data is ${Math.round(ageMinutes)} min old (budget ${budget} min).`,
      );
    }
  }

  // Probability integrity — a model/data bug, caught here before it misleads.
  const ml = pred.model.moneyline;
  if (Math.abs(ml.homeWinProb + ml.awayWinProb - 1) > PROB_SUM_TOLERANCE) {
    flag(
      "critical",
      "PROB_SUM_INVALID",
      `Moneyline probabilities sum to ${(ml.homeWinProb + ml.awayWinProb).toFixed(3)}, not ~1.`,
    );
  }
  const tot = pred.model.total;
  if (Math.abs(tot.overProb + tot.underProb - 1) > PROB_SUM_TOLERANCE) {
    flag(
      "critical",
      "PROB_SUM_INVALID",
      `Total over/under probabilities sum to ${(tot.overProb + tot.underProb).toFixed(3)}, not ~1.`,
    );
  }

  return { flags, cap };
}

export async function reviewDataAuditor(
  pred: GamePrediction,
  provider: ReviewProvider,
  now: Date,
): Promise<AgentVerdict> {
  const { flags: heuristicFlags, cap: heuristicCap } = auditRules(pred, now);
  let cap = heuristicCap;
  const flags: ReviewFlag[] = [...heuristicFlags];
  let reasoning = "";
  let source: AgentVerdict["source"] = "heuristic";

  if (provider.available) {
    const outcome = await provider.reason({
      system: DATA_AUDITOR_SYSTEM,
      context: serializePrediction(pred),
    });
    if (outcome.ok && outcome.verdict) {
      flags.push(...llmConcernsToFlags(AGENT, outcome.verdict));
      cap = mergeCaps(cap, llmRankToCap(outcome.verdict.suggestedMaxRank));
      reasoning = outcome.verdict.overallAssessment;
      source = "heuristic+llm";
    } else {
      reasoning = `LLM review unavailable (${outcome.note}); deterministic checks only.`;
    }
  }

  const worst = worstSeverity(flags);
  if (!reasoning) {
    reasoning =
      worst === null
        ? "Data is complete, fresh, and internally consistent."
        : `Found ${flags.length} data issue(s); most severe: ${worst}.`;
  }

  return {
    agent: AGENT,
    ok: worst === null || worst === "info",
    flags,
    suggestedMaxRank: cap,
    reasoning,
    source,
  };
}
