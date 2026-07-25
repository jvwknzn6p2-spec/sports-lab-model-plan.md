/**
 * Step 9 — Reviewer backends.
 *
 * Two implementations of the same `Reviewer` function type:
 *
 *   - {@link createClaudeReviewer} — calls Claude with the verdict schema as a
 *     structured-output constraint.
 *   - {@link ruleBasedReviewer} — a deterministic reviewer that reads the same
 *     dossier and applies fixed heuristics.
 *
 * The rule-based one is not a toy. The daily pipeline must run when there is no
 * API key, when the network is down, and inside tests — and a review layer that
 * takes the whole pipeline down with it would be worse than no review layer.
 * It is also what the tests exercise, so the suite stays hermetic and free.
 */
import Anthropic from "@anthropic-ai/sdk";
import { reviewVerdictSchema, REVIEW_VERDICT_JSON_SCHEMA, type ReviewAgent, type ReviewVerdict } from "./schemas";
import { roleBrief, reviewTask } from "./prompts";

/** Reviews one game as one agent. Both backends satisfy this. */
export type Reviewer = (agent: ReviewAgent, dossier: string) => Promise<ReviewVerdict>;

/** Raised when the model declines to answer or returns something unusable. */
export class ReviewError extends Error {
  readonly agent: ReviewAgent;
  constructor(agent: ReviewAgent, message: string) {
    super(`[${agent}] ${message}`);
    this.name = "ReviewError";
    this.agent = agent;
  }
}

/**
 * Effort per agent — the main cost lever after prompt caching.
 *
 * The Data Auditor is a checklist pass over facts already in the dossier and
 * runs cheap. The Risk Reviewer is the hardest judgement call in the layer and
 * is the one whose verdict most often changes what a user acts on, so it gets
 * the most room to think.
 */
const AGENT_EFFORT: Record<ReviewAgent, "low" | "medium" | "high"> = {
  "data-auditor": "low",
  "matchup-analyst": "medium",
  "risk-reviewer": "high",
};

export interface ClaudeReviewerOptions {
  /** Pass an existing client to share connection pooling and config. */
  client?: Anthropic;
  /** Defaults to Claude Opus 5. */
  model?: string;
  /**
   * Output cap per reviewer. Thinking is on by default on Claude Opus 5 and
   * counts against this, so leave headroom above the size of the verdict
   * itself — a tight cap truncates mid-thought rather than mid-answer.
   */
  maxTokens?: number;
}

/**
 * Build a reviewer backed by the Claude API.
 *
 * The dossier is the first system block and carries the cache breakpoint; the
 * per-agent role brief follows it. Because all three agents send the same first
 * block, they share one cached prefix — see `prompts.ts` for why the ordering
 * matters.
 */
export function createClaudeReviewer(options: ClaudeReviewerOptions = {}): Reviewer {
  // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or
  // an `ant auth login` profile — don't require the caller to plumb a key.
  const client = options.client ?? new Anthropic();
  const model = options.model ?? "claude-opus-5";
  const maxTokens = options.maxTokens ?? 8000;

  return async function claudeReviewer(agent, dossier) {
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        // Recover a declined request on a fallback model rather than losing the
        // review. Benign analysis rarely trips a classifier, but a review layer
        // that silently drops a game is worse than one that costs a retry.
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }],
        system: [
          // Shared across all three agents → this is the cached prefix.
          { type: "text", text: dossier, cache_control: { type: "ephemeral" } },
          // Per-agent, after the breakpoint.
          { type: "text", text: roleBrief(agent) },
        ],
        output_config: {
          effort: AGENT_EFFORT[agent],
          format: { type: "json_schema", schema: REVIEW_VERDICT_JSON_SCHEMA },
        },
        messages: [{ role: "user", content: reviewTask(agent) }],
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new ReviewError(agent, "rate limited by the Claude API");
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new ReviewError(agent, "could not reach the Claude API");
      }
      if (error instanceof Anthropic.APIError) {
        throw new ReviewError(agent, `Claude API error ${error.status}: ${error.message}`);
      }
      throw error;
    }

    // Check the stop reason before touching content: a refusal returns HTTP 200
    // with empty or partial content, so indexing content[0] blindly would throw
    // or, worse, read half an answer as a whole one.
    if (response.stop_reason === "refusal") {
      throw new ReviewError(agent, "the model declined to review this game");
    }

    const text = response.content.find((block) => block.type === "text");
    if (text === undefined || text.type !== "text") {
      throw new ReviewError(agent, "response contained no text block");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      throw new ReviewError(agent, "response was not valid JSON");
    }

    // Validate independently of the API's own schema constraint. Two checks on
    // one shape: a response that somehow evades one still fails the other.
    const result = reviewVerdictSchema.safeParse(parsed);
    if (!result.success) {
      throw new ReviewError(agent, `verdict did not match the schema: ${result.error.message}`);
    }

    // The agent field is the model's, so pin it to the agent we actually asked.
    return { ...result.data, agent };
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic fallback                                                      */
/* -------------------------------------------------------------------------- */

/** Case-insensitive substring test against the dossier. */
function mentions(dossier: string, needle: string): boolean {
  return dossier.toLowerCase().includes(needle.toLowerCase());
}

/**
 * A deterministic reviewer that reads the same dossier and applies fixed rules.
 *
 * Deliberately conservative: it only reacts to signals that are unambiguous in
 * the dossier text, and endorses otherwise. It is a safety net for when the API
 * is unavailable, not a simulation of the model's judgement.
 */
export const ruleBasedReviewer: Reviewer = async (agent, dossier) => {
  const warnings: string[] = [];
  let delta = 0;

  switch (agent) {
    case "data-auditor": {
      if (mentions(dossier, "NOT NAMED")) {
        warnings.push("A starting pitcher is not named.");
        delta += 2;
      }
      if (mentions(dossier, "NEUTRAL FALLBACK")) {
        warnings.push("Ballpark factors fell back to neutral; venue is not in the table.");
        delta += 1;
      }
      if (mentions(dossier, "LINEUP NOT CONFIRMED")) {
        warnings.push("A lineup is not yet confirmed.");
        delta += 1;
      }
      if (mentions(dossier, "confirmed=false")) {
        warnings.push("A named starting pitcher is not yet confirmed by the club.");
        delta += 1;
      }
      if (mentions(dossier, "[error]")) {
        warnings.push("Validation raised an error-level flag.");
        delta += 1;
      }
      break;
    }

    case "matchup-analyst": {
      if (mentions(dossier, "key-hitter) out")) {
        warnings.push("A key hitter is out; lineup strength may shift more than the flat penalty implies.");
        delta += 1;
      }
      if (mentions(dossier, "bullpen threw")) {
        warnings.push("A bullpen is carrying recent workload into this game.");
      }
      break;
    }

    case "risk-reviewer": {
      if (mentions(dossier, "Implausible edge")) {
        warnings.push("Edge is larger than a sharp market usually allows.");
        delta += 1;
      }
      if (mentions(dossier, "FORECAST")) {
        warnings.push("Weather is forecast rather than observed; conditions may differ at first pitch.");
      }
      break;
    }
  }

  const assessment = delta >= 2 ? "reject" : delta === 1 ? "caution" : "endorse";

  return {
    agent,
    assessment,
    confidenceDelta: Math.min(delta, 3),
    warnings,
    reasoning:
      warnings.length === 0
        ? "Deterministic review found nothing in the dossier that undermines this pick."
        : `Deterministic review found ${warnings.length} issue(s) in the dossier.`,
  };
};
