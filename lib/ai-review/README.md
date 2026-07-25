# @workspace/ai-review — Step 9: AI multi-agent review

The final sanity-check layer of the AI Sports Lab pipeline (see
[`sports-lab/model-plan.md`](../../sports-lab/model-plan.md), Sections 4.5 and
Step 9). Three specialist reviewers examine a finished prediction and its
context, then adjust confidence and attach warnings — **before** a pick is
published.

## The core invariant

> "The AI review can **lower** confidence or add warnings, but the numbers still
> come from the statistical model + simulation. AI is the reviewer, not the
> source of truth."

The review never rewrites a probability and **can only ever downgrade
confidence, never raise it**. This is enforced deterministically in
[`confidence.ts`](./src/confidence.ts) (`applyReview`) and covered by tests.

## The three agents

Each agent runs two passes: a **deterministic guardrail pass** that always runs,
plus an **optional LLM reasoning pass** (Claude) for qualitative judgment. If no
API key is configured — or the model refuses/errors — the agent degrades
gracefully to its deterministic verdict; the failure is reported, never
swallowed.

| Agent | Focus | Balance |
|---|---|---|
| **Data Auditor** | Inputs present, fresh, internally consistent (unconfirmed starters, missing odds, stale data, implausible stats, probability sums) | deterministic-heavy |
| **Matchup Analyst** | Qualitative context — injuries, pitcher trends, weather vs. the total | LLM-first |
| **Risk Reviewer** | Challenges over-confidence — thin edge, low component agreement, coin-flip picks, non-positive EV | adversarial |

The orchestrator caps the final rank at the **most conservative** suggestion
across all agents.

## Usage

```ts
import { reviewPrediction, defaultProvider } from "@workspace/ai-review";

const result = await reviewPrediction(prediction, {
  provider: defaultProvider(), // Anthropic when ANTHROPIC_API_KEY is set, else offline
});

console.log(result.finalConfidence); // e.g. "B" (downgraded from "A")
console.log(result.warnings);        // report-ready lines
```

Review a whole slate (concurrency-limited):

```ts
import { reviewSlate } from "@workspace/ai-review";
const results = await reviewSlate(predictions, { concurrency: 4 });
```

## Provider model

- `AnthropicReviewProvider` — Claude (`claude-opus-5` by default) with adaptive
  thinking, structured outputs (`output_config.format`), a prompt-cached
  per-agent system prompt, and graceful handling of refusals/errors.
- `HeuristicReviewProvider` — offline, deterministic-only. The default when no
  API key is present, and what the tests and demo use.

`defaultProvider()` picks the live provider when `ANTHROPIC_API_KEY` is set,
otherwise the offline one.

## Commands

```bash
pnpm --filter @workspace/ai-review run demo       # run the sample slate (offline by default)
pnpm --filter @workspace/ai-review run test       # unit tests (node:test)
pnpm --filter @workspace/ai-review run typecheck   # tsc --noEmit
```

Set `ANTHROPIC_API_KEY` before `run demo` to exercise the full Claude-backed
review.

## Where this fits

This is Step 9 of the 11-step build order. It consumes the `GamePrediction`
contract (the hand-off from Step 7, confidence ranking) defined in
[`types.ts`](./src/types.ts). Steps 1–8 (data + statistical model + simulation +
EV + ranking) and Steps 10–11 (daily output + automation) are separate stages;
until they exist, [`sample-data.ts`](./src/sample-data.ts) stands in for their
output so the review layer is runnable and testable on its own.
