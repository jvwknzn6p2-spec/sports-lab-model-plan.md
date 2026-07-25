# AI Sports Lab

An MLB/NPB game-prediction system that turns a validated **Control Tower** data
handoff into an operational, auditable prediction for each game — winner, run
line, expected score, confidence tier, and expected-value signal — then locks,
settles, and learns from the result. See `sports-lab/model-plan.md` for the
product blueprint.

## Where things live

- **`handiedge_engine/`** — the production system (Python 3.11, FastAPI, XGBoost,
  SQLAlchemy + Alembic). This is the executable pipeline: data ingestion →
  prediction → calibration → decision → **AI multi-agent review** → lock →
  settlement → error analysis → self-learning. Start here.
- **`sports-lab/model-plan.md`** — the v1.0 technical plan (source of truth for
  scope and terminology).
- **`lib/`** — the shared pnpm/TypeScript workspace scaffold (API spec, generated
  clients, DB schema) retained from the repo baseline.
- **`CONSOLIDATION.md`** — provenance: how the seven development branches were
  consolidated into this single system, and what each contributed.

## Run & Operate (the engine)

All commands run from `handiedge_engine/`:

- `pip install -e ".[dev,xgboost]"` — install the engine with dev + XGBoost extras
- `python -m pytest` — full test suite (unit + integration + contract)
- `bash scripts/run_e2e.sh` — end-to-end lifecycle demo on SQLite (migrate →
  validate → predict → **AI review** → lock → settle → analyze → learn)
- `python -m app.cli.main --help` — CLI (same services as the API, no duplicated logic)
- `uvicorn app.main:create_app --factory` — run the API
- Required env: `HANDIEDGE_DATABASE_URL` (Postgres in prod; SQLite for local/tests)
- Optional env: `ANTHROPIC_API_KEY` — enables the LLM reasoning pass in the AI
  review layer (deterministic guardrails always run without it)

## Architecture decisions

- **One runtime, one system.** The consolidated codebase is the Python
  `handiedge_engine`. The earlier TypeScript pipeline slices were superseded to
  avoid two parallel implementations of the same pipeline (see `CONSOLIDATION.md`).
- **Modular monolith with strict domain boundaries.** Business logic lives in
  `app/domain/*`; `app/services/*` orchestrate; `app/api` and `app/cli` are thin
  adapters over the *same* services.
- **AI is the reviewer, not the source of truth.** The Step 9 multi-agent review
  can only downgrade confidence or attach warnings — never rewrite a probability
  (enforced deterministically in `app/domain/ai_review/confidence.py`).
- **Fail loudly.** Missing/stale/contradictory evidence yields `PASS`/`BLOCKED`,
  never a fabricated number. The prediction adapter is isolated behind a protocol
  so the non-production deterministic fallback can never masquerade as a real model.
- **Everything is auditable.** Every state transition — including each AI-review
  verdict and tier movement — is recorded as an audit event and stored in the
  locked prediction payload.

## Gotchas

- Run `python -m alembic upgrade head` before the first `predict` on a fresh DB.
- The bundled prediction model is a **NON_PRODUCTION_FALLBACK**; wire a trained
  XGBoost adapter before real use (`handiedge_engine/README.md` §3).

## Pointers

- `handiedge_engine/README.md` — full engine architecture, domain boundaries, and
  the production model-adapter integration guide.
