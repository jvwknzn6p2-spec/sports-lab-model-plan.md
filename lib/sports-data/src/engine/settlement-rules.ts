/**
 * Settlement rules as first-class, versioned objects.
 *
 * Every evaluation in this repository is scored against ONE of these rules,
 * and the rule tag (`id/vN`) travels with the evaluation so that a change of
 * basis is never silent (.ai/ASTRA_REVIEW_POLICY.md §2, Appendix A.3). The
 * production settle path (`handiedge settle`) uses the league's `production`
 * rule; re-evaluations under another rule are appended separately
 * (`reevaluate.ts`) and never overwrite the original evaluation.
 */

export type SettlementRuleId =
  | "MLB_FINAL_SCORE"
  | "NPB_FINAL_POSTED_SCORE"
  | "NPB_REGULATION_9";

export interface SettlementRule {
  id: SettlementRuleId;
  version: number;
  league: "mlb" | "npb";
  /** What score the outcome is read from. */
  basis: string;
  /** A level score under this basis is a PUSH (never invented into a win). */
  tie: "PUSH";
  /**
   * `production`  — what `handiedge settle` applies today (history.jsonl).
   * `reevaluation` — applied only by `handiedge reevaluate`, appended to
   *                  reevaluations.jsonl next to, never instead of, the original.
   */
  status: "production" | "reevaluation";
  /** First slate date the rule may be applied to (null = any). */
  appliesFrom: string | null;
  /** Edge cases and how they are read; UNKNOWN items are stated as such. */
  notes: readonly string[];
}

export const SETTLEMENT_RULES: Readonly<Record<SettlementRuleId, SettlementRule>> = {
  MLB_FINAL_SCORE: {
    id: "MLB_FINAL_SCORE",
    version: 1,
    league: "mlb",
    basis: "MLB Stats API final score of a Final game, extra innings included",
    tie: "PUSH",
    status: "production",
    appliesFrom: null,
    notes: [
      "MLB plays extras, so a level final score only arrives from a feed glitch or a suspended game; it settles as a PUSH.",
    ],
  },
  NPB_FINAL_POSTED_SCORE: {
    id: "NPB_FINAL_POSTED_SCORE",
    version: 1,
    league: "npb",
    basis: "score posted on npb.jp's month schedule page (final; NPB plays up to the 12th inning)",
    tie: "PUSH",
    status: "production",
    appliesFrom: null,
    notes: [
      "This is the basis history.jsonl was built on. It differs from the handicap market's regulation-9 basis; see NPB_REGULATION_9.",
      "A tie after the 12th inning is a real NPB result and settles as a PUSH.",
    ],
  },
  NPB_REGULATION_9: {
    id: "NPB_REGULATION_9",
    version: 1,
    league: "npb",
    basis: "score at the end of the 9th inning (from the inning-by-inning line of npb.jp's score page)",
    tie: "PUSH",
    status: "reevaluation",
    appliesFrom: "2026-08-22",
    notes: [
      "Bottom of the 9th not played (home leads after the top): the final score IS the regulation score.",
      "Sayonara in the bottom of the 9th: counted (the 9th inning is complete when the game ends); marked `x` on the score page.",
      "Called game (コールド) before the 9th: the score at the call is the regulation score (innings_played < 9).",
      "Extra innings: only the first 9 innings count; a level score after 9 is a PUSH even when the 10th–12th decided the game.",
      "Cancelled (中止) games have no score under any rule; NPB does not resume suspended games in the regular season.",
      "UNKNOWN: whether every handicap book applies exactly this reading to called games and to games shortened by weather after the 5th inning. The market rule as confirmed by the Founder (VORTE EV, 2026-08-11) is 'decided at the end of the 9th'.",
    ],
  },
};

export function ruleTag(rule: Pick<SettlementRule, "id" | "version">): string {
  return `${rule.id}/v${rule.version}`;
}

export function productionRule(league: "mlb" | "npb"): SettlementRule {
  return league === "mlb"
    ? SETTLEMENT_RULES.MLB_FINAL_SCORE
    : SETTLEMENT_RULES.NPB_FINAL_POSTED_SCORE;
}

export function ruleById(id: string): SettlementRule {
  const rule = (SETTLEMENT_RULES as Record<string, SettlementRule>)[id];
  if (!rule) throw new Error(`unknown settlement rule: ${id}`);
  return rule;
}
