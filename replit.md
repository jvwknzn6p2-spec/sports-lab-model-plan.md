# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `bash run_pipeline.sh 2026-07-25` — run the full prediction pipeline end-to-end on fixtures (train → predict → AI review + lock → settle → analyze → learn)
- `pnpm --filter @workspace/ai-review run demo` — run the AI review over the sample slate (offline by default; set `ANTHROPIC_API_KEY` for the full Claude-backed review)
- `pnpm --filter @workspace/ai-review run test` / `pnpm --filter @workspace/pipeline run test` — TypeScript unit tests
- `cd prediction-engine && PYTHONPATH=src python -m pytest` — Python engine unit tests
- Required env: `DATABASE_URL` — Postgres connection string; `ANTHROPIC_API_KEY` — enables the live AI review (optional; falls back to deterministic-only review when absent)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `sports-lab/model-plan.md` — the technical plan (source of truth for scope and build order).
- `lib/ai-review` (`@workspace/ai-review`) — **AI multi-agent review** (Data Auditor, Matchup Analyst, Risk Reviewer). Consumes the `GamePrediction` contract in `lib/ai-review/src/types.ts` and returns an adjusted confidence rank + warnings. See that package's `README.md`.
- `prediction-engine/` (`sportslab-engine`, Python) — the ML half: data ingestion, feature engineering, XGBoost training/inference, ensemble, calibration, error analysis, self-learning. See its `README.md`.
- `lib/pipeline` (`@workspace/pipeline`) — TypeScript orchestration: **Prediction Lock** (runs the AI review, then freezes an immutable hashed pick) and **Settlement Engine**.
- `run_pipeline.sh` — runs the full end-to-end loop (train → predict → lock+review → settle → analyze → learn) on recorded fixtures.
- **Architecture (v1.1):** ML is the source of truth; the transparent v1.0 baseline is an ensemble member. See `sports-lab/model-plan.md` §9 for the 7-component pipeline, decisions, and remaining live-wiring work. Live data ingestion is blocked by this environment's egress policy, so the pipeline runs on recorded fixtures (`SPORTSLAB_USE_FIXTURES=1`).

## Architecture decisions

- **AI review can only downgrade confidence, never raise it.** Enforced deterministically in `lib/ai-review/src/confidence.ts` (`applyReview`) and asserted by tests. The LLM annotates and caps; it never rewrites a model probability.
- **Every review agent has a deterministic guardrail pass plus an optional LLM pass.** Objective checks (unconfirmed starter, missing odds, probability sums) always run and cannot be talked out of by the model; the LLM adds qualitative judgment on top.
- **The reasoning provider is pluggable** (`ReviewProvider`). With no `ANTHROPIC_API_KEY` — or on a model refusal/error — the system degrades to deterministic-only review rather than blocking a pick. This keeps the whole layer runnable and testable offline / in CI.
- **Live provider uses Claude `claude-opus-5`** with adaptive thinking, structured outputs (`output_config.format`), and a prompt-cached per-agent system prompt.

## Product

AI Sports Lab v1.0 — an MLB game-prediction and betting-value decision-support tool. For each scheduled game it predicts the moneyline winner, run line, and total, assigns an S/A/B/C confidence rank, and flags positive-EV bets. The AI multi-agent review (Step 9) is the final layer that audits data quality, reviews qualitative matchup context, challenges over-confident picks, and can only ever downgrade confidence — never invent numbers.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
