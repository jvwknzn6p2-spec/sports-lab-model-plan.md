/**
 * Step 9 — AI multi-agent review: verdict contract.
 *
 * The plan is explicit about the power this layer has (Section 4.5): the AI
 * review can **lower** confidence or add warnings, but the numbers still come
 * from the statistical model and the simulation. AI is the reviewer, not the
 * source of truth.
 *
 * That constraint is encoded in the schema rather than left to convention:
 * `confidenceDelta` is a non-negative count of rank *steps down*, so there is
 * no representable verdict that raises a rank. A reviewer cannot promote a
 * pick even if it wants to — the JSON schema the model is constrained to
 * cannot express it.
 */
import { z } from "zod";

/** The three reviewers from plan Section 4.5. */
export const reviewAgentSchema = z.enum(["data-auditor", "matchup-analyst", "risk-reviewer"]);
export type ReviewAgent = z.infer<typeof reviewAgentSchema>;

/**
 * A reviewer's overall stance.
 *   - endorse — nothing found that undermines the pick
 *   - caution — usable, but the rank should come down
 *   - reject  — do not act on this pick
 */
export const assessmentSchema = z.enum(["endorse", "caution", "reject"]);
export type Assessment = z.infer<typeof assessmentSchema>;

export const reviewVerdictSchema = z.object({
  agent: reviewAgentSchema,
  assessment: assessmentSchema,
  /**
   * How many confidence ranks to drop. Zero means "no change".
   *
   * Non-negative by construction — a reviewer can only ever lower confidence.
   * Capped at 3, which is the full distance from S to C.
   */
  confidenceDelta: z.number().int().min(0).max(3),
  /** Short, report-ready warnings. Empty when the reviewer found nothing. */
  warnings: z.array(z.string()),
  /** One or two sentences explaining the stance, for the audit trail. */
  reasoning: z.string(),
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/**
 * The same contract as a raw JSON Schema, for `output_config.format`.
 *
 * Kept alongside the zod schema deliberately: the API constrains generation
 * with this, and zod validates what comes back. Two independent checks on the
 * same shape — a model response that somehow evades one still fails the other.
 *
 * Structured-output rules: every object needs `additionalProperties: false`
 * and an explicit `required` list.
 */
export const REVIEW_VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    agent: { type: "string", enum: ["data-auditor", "matchup-analyst", "risk-reviewer"] },
    assessment: { type: "string", enum: ["endorse", "caution", "reject"] },
    confidenceDelta: {
      type: "integer",
      enum: [0, 1, 2, 3],
      description: "Confidence ranks to drop. 0 = no change. Never negative — you cannot raise confidence.",
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Short report-ready warnings. Empty array when nothing was found.",
    },
    reasoning: { type: "string", description: "One or two sentences justifying the assessment." },
  },
  required: ["agent", "assessment", "confidenceDelta", "warnings", "reasoning"],
  additionalProperties: false,
} as const;
