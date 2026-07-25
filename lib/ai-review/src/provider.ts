/**
 * Reasoning-provider abstraction for the review agents.
 *
 * Agents never talk to the Anthropic SDK directly — they call a
 * {@link ReviewProvider}. This keeps the agents pure and testable, and lets the
 * whole pipeline run offline (or in CI, or on a game where we deliberately want
 * deterministic-only review) via {@link HeuristicReviewProvider}.
 *
 * The live provider uses Claude (Opus 5 by default) with adaptive thinking and
 * structured outputs, and a cached system prompt per agent role.
 */

import type { LlmVerdict } from "./schema.js";
import {
  LLM_VERDICT_JSON_SCHEMA,
  LLM_VERDICT_SCHEMA_NAME,
  llmVerdictSchema,
} from "./schema.js";

/** A single reasoning request against one agent's role prompt. */
export interface ReasonRequest {
  /** Stable, role-specific system prompt (prompt-cached). */
  system: string;
  /** Per-game serialized prediction context (volatile). */
  context: string;
}

/** The outcome of a reasoning request. */
export interface ReasonOutcome {
  /** True only when the model returned a schema-valid verdict. */
  ok: boolean;
  verdict: LlmVerdict | null;
  /**
   * Provenance / failure note: "ok", "offline", "refusal", "invalid-output",
   * or "error: <message>". Surfaced to callers so a degraded review is never
   * silent.
   */
  note: string;
}

export interface ReviewProvider {
  readonly kind: string;
  /** Whether this provider can actually produce LLM judgment. */
  readonly available: boolean;
  reason(req: ReasonRequest): Promise<ReasonOutcome>;
}

/**
 * Offline provider. Produces no LLM judgment; agents fall back to their
 * deterministic rule passes. This is the default when no API key is present.
 */
export class HeuristicReviewProvider implements ReviewProvider {
  readonly kind = "heuristic";
  readonly available = false;

  async reason(_req: ReasonRequest): Promise<ReasonOutcome> {
    return { ok: false, verdict: null, note: "offline" };
  }
}

export interface AnthropicProviderOptions {
  /** Defaults to the `ANTHROPIC_API_KEY` env var. */
  apiKey?: string;
  /** Defaults to "claude-opus-5". */
  model?: string;
  /** Output token cap. Reviews are short; defaults to 4096. */
  maxTokens?: number;
}

/**
 * Live provider backed by the Anthropic Messages API.
 *
 * The SDK is imported dynamically so that consumers who only use the heuristic
 * path (tests, CI, offline runs) never need `@anthropic-ai/sdk` at runtime.
 *
 * Reliability posture: a review is a *check*, not the source of truth. If the
 * model refuses, errors, or returns malformed output, we degrade to the
 * deterministic verdict rather than block the pick — the failure is reported in
 * {@link ReasonOutcome.note}, never swallowed.
 */
export class AnthropicReviewProvider implements ReviewProvider {
  readonly kind = "anthropic";
  readonly available = true;

  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly maxTokens: number;
  // Lazily-constructed SDK client; typed loosely to avoid a hard type
  // dependency on the SDK in the heuristic-only code path.
  private client: unknown;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = options.model ?? "claude-opus-5";
    this.maxTokens = options.maxTokens ?? 4096;
  }

  private async getClient(): Promise<{
    messages: {
      create(params: Record<string, unknown>): Promise<AnthropicMessage>;
    };
  }> {
    if (this.client === undefined) {
      const mod = await import("@anthropic-ai/sdk");
      const Anthropic = mod.default;
      this.client = this.apiKey
        ? new Anthropic({ apiKey: this.apiKey })
        : new Anthropic();
    }
    return this.client as {
      messages: {
        create(params: Record<string, unknown>): Promise<AnthropicMessage>;
      };
    };
  }

  async reason(req: ReasonRequest): Promise<ReasonOutcome> {
    let client: Awaited<ReturnType<AnthropicReviewProvider["getClient"]>>;
    try {
      client = await this.getClient();
    } catch (err) {
      return { ok: false, verdict: null, note: `error: ${describe(err)}` };
    }

    let response: AnthropicMessage;
    try {
      response = await client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        thinking: { type: "adaptive" },
        system: [
          {
            type: "text",
            text: req.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            name: LLM_VERDICT_SCHEMA_NAME,
            schema: LLM_VERDICT_JSON_SCHEMA,
          },
        },
        messages: [{ role: "user", content: req.context }],
      });
    } catch (err) {
      return { ok: false, verdict: null, note: `error: ${describe(err)}` };
    }

    // Opus 5 safety classifiers can decline a request (HTTP 200). A review must
    // never crash on this — degrade to deterministic-only.
    if (response.stop_reason === "refusal") {
      return { ok: false, verdict: null, note: "refusal" };
    }

    const text = extractText(response);
    if (!text) {
      return { ok: false, verdict: null, note: "invalid-output" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, verdict: null, note: "invalid-output" };
    }

    const validated = llmVerdictSchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, verdict: null, note: "invalid-output" };
    }

    return { ok: true, verdict: validated.data, note: "ok" };
  }
}

// ---------------------------------------------------------------------------
// Minimal structural typing for the SDK response we read. We only touch two
// fields, so we describe just those rather than depend on the SDK's types.
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicMessage {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string } | AnthropicTextBlock>;
}

function extractText(message: AnthropicMessage): string | null {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Choose a provider from the environment: the live Anthropic provider when an
 * API key is available, otherwise the offline heuristic provider. Callers who
 * want to force one can construct it directly.
 */
export function defaultProvider(
  options: AnthropicProviderOptions = {},
): ReviewProvider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return apiKey
    ? new AnthropicReviewProvider(options)
    : new HeuristicReviewProvider();
}
