/**
 * The structured-output contract shared by all three LLM reviewer passes.
 *
 * We keep two representations deliberately in sync:
 *  - `llmVerdictSchema` (Zod) validates the JSON the model returns at runtime.
 *  - `LLM_VERDICT_JSON_SCHEMA` is the JSON Schema handed to the Anthropic
 *    Messages API via `output_config.format`, which constrains generation.
 *
 * They are hand-mirrored rather than derived so we retain exact control over
 * the API-side schema constraints (`additionalProperties: false`, enums), which
 * the structured-outputs feature requires.
 */

import { z } from "zod/v4";

/** A concern raised by the model, mirroring {@link ReviewFlag} minus `agent`. */
export const llmConcernSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
});

/**
 * The model's structured verdict. `suggestedMaxRank` uses the sentinel
 * `"none"` (rather than null) because the structured-outputs JSON Schema
 * subset does not support nullable unions cleanly; we normalize it to `null`
 * in the provider layer.
 */
export const llmVerdictSchema = z.object({
  concerns: z.array(llmConcernSchema),
  suggestedMaxRank: z.enum(["S", "A", "B", "C", "none"]),
  overallAssessment: z.string(),
});

export type LlmConcern = z.infer<typeof llmConcernSchema>;
export type LlmVerdict = z.infer<typeof llmVerdictSchema>;

/**
 * JSON Schema passed to `output_config.format`. Must satisfy the structured
 * outputs subset: every object sets `additionalProperties: false` and lists
 * its `required` keys; no numeric/string length constraints.
 */
export const LLM_VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    concerns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: {
            type: "string",
            description: "SCREAMING_SNAKE_CASE machine-readable issue code.",
          },
          severity: {
            type: "string",
            enum: ["info", "warning", "critical"],
          },
          message: {
            type: "string",
            description: "One-sentence, report-ready description of the concern.",
          },
        },
        required: ["code", "severity", "message"],
      },
    },
    suggestedMaxRank: {
      type: "string",
      enum: ["S", "A", "B", "C", "none"],
      description:
        "Highest confidence rank this pick should be allowed to hold. 'none' means no cap.",
    },
    overallAssessment: {
      type: "string",
      description: "1–3 sentence summary of your review.",
    },
  },
  required: ["concerns", "suggestedMaxRank", "overallAssessment"],
} as const;

export const LLM_VERDICT_SCHEMA_NAME = "sports_lab_review_verdict";
