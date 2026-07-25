# Branch Consolidation Record

This repository's feature work was developed across seven parallel `claude/*`
branches, each implementing one or more stages of the AI Sports Lab pipeline
(`sports-lab/model-plan.md`). Two incompatible runtimes emerged: a Python
FastAPI + XGBoost engine, and a set of TypeScript pnpm-workspace pipeline
slices. This record documents how they were consolidated into a **single
production-ready system** on the integration branch, for auditability.

## Decision

**Integration baseline (branch A): `claude/handiedge-engine-pipeline-r0l0a6`.**

It was the only branch that already implemented the full pipeline end to end in
one runtime — data ingestion → prediction (XGBoost adapter + Poisson +
deterministic fallback) → calibration → decision → lock → settlement → error
analysis → self-learning — with a working `scripts/run_e2e.sh`, a unit /
integration / contract test suite, Alembic migrations, and Docker packaging. It
is also the branch that uses XGBoost, which is why the `xgboost` repository is in
scope for this work.

The one capability the baseline lacked was the **AI multi-agent review**
(model-plan Step 9 / §4.5), which existed only as a standalone TypeScript package
on `claude/step-9-ai-multi-agent-review-1lg1xi`. That layer was **ported into the
baseline as a native Python domain stage** rather than run as a second runtime,
so the deliverable remains one executable system.

## Branch disposition

| Branch | Role | Disposition |
|---|---|---|
| `handiedge-engine-pipeline-r0l0a6` | **Baseline (A)** — full Python pipeline, XGBoost, Docker, e2e | **Adopted** as the trunk |
| `step-9-ai-multi-agent-review-1lg1xi` | AI multi-agent review (TS `lib/ai-review`) | **Ported to Python** at `app/domain/ai_review/` and wired between the Decision Engine and prediction lock |
| `data-collection-step-1-gtb6z8` | TS pipeline slice (collect → simulate → EV → calibration loop) | Superseded — same stages exist in the Python engine |
| `step2-pitcher-batting-analysis-dqd84p` | TS FIP/sabermetrics + predict/settle CLI | Superseded — features + settlement live in the engine |
| `step-3-context-validation-fxlstd` | TS context/validation + baseline + MC | Superseded — validation + decisioning live in the engine |
| `monte-carlo-simulation-s23i5m` | TS Monte-Carlo + market pricing | Superseded — Poisson/margin + market handling live in the engine |
| `learner-features-bug-fix-e7c5wy` | TS schedule + core stats | Superseded — ingestion lives in the engine |

The five superseded TypeScript pipeline branches were intentionally **not
merged as parallel code**: doing so would reintroduce a second, parallel
implementation of the same pipeline — exactly the duplication this consolidation
removes. Instead, their **best ideas were merged into the Python engine**:

- The **daily data-collection + sabermetrics** approach from `data-collection-step-1`
  and `step2-pitcher-batting-analysis` (which MLB Stats API endpoints/fields to
  pull for the day's slate, probable starters, season ERA/WHIP, and team wOBA) is
  now the Python **Feature Engineering** front stage: `app/domain/feature_engineering`
  (shared sabermetrics — one wOBA/ERA/WHIP implementation for both training and
  daily scoring), `app/infrastructure/data_sources/mlb_live.py`, and
  `app/services/daily_slate_service.py`, driven by the `handiedge daily` command.
- The **AI multi-agent review** from `step-9` (ported earlier) at `app/domain/ai_review`.

The shared TS workspace scaffold in `lib/` (API spec, generated clients, DB
schema) is retained from the repo baseline and is unaffected. There is now **one
prediction pipeline** (Python); no TypeScript prediction code is maintained.

## What the AI-review port preserves

The Python port at `app/domain/ai_review/` is a faithful re-implementation of the
TypeScript `lib/ai-review` package, keeping its core invariant and structure:

- **Three specialist reviewers** — Data Auditor (deterministic-heavy), Matchup
  Analyst (qualitative), Risk Reviewer (adversarial).
- **AI only downgrades.** The review may lower the confidence tier or attach
  warnings; it can never raise a tier or rewrite a probability. This is enforced
  deterministically in `app/domain/ai_review/confidence.py` and covered by tests
  (`tests/unit/test_ai_review.py`, `tests/integration/test_ai_review_pipeline.py`).
- **Deterministic-first, LLM-optional.** Guardrail rules always run and are fully
  offline/reproducible; an Anthropic reasoning pass is used only when
  `ANTHROPIC_API_KEY` is set, degrading gracefully (never blocking a pick) on
  refusal or error.
- **Adapted to HandiEdge's domain.** The reviewers read a normalized
  `ReviewContext` built from the Control Tower payload + Decision output
  (`app/domain/ai_review/context.py`), and the coarse S/A/B/C cap is folded back
  onto the engine's fine 13-value `ConfidenceTier` without ever raising it.

## Verification

The consolidated system builds and passes end to end across every required
stage — Feature Engineering → Prediction → Calibration → AI Multi-Agent Review →
Prediction Lock → Settlement → Error Analysis → Self Learning:

- `python -m pytest` — **213 passed** (132 baseline + 74 AI-review + 7 daily-path tests).
- `bash scripts/run_e2e.sh` — full lifecycle green: migrate → validate → predict
  (incl. calibration + AI review) → AI review → lock → settle → error analysis →
  learning workflow.
- `handiedge daily --date YYYY-MM-DD` — feature-engineers a real MLB slate and runs
  the whole pipeline to a daily report (verified offline with recorded fixtures;
  live runs need outbound access to `statsapi.mlb.com`).
- `ruff check` — clean on all new/changed files.
