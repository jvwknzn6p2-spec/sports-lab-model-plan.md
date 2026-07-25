# HandiEdge — Sports-Betting Handicap Prediction (Domain Core)

A safe, auditable Python domain core for handicap prediction, implemented from the
`HandiEdge-Implementation-Skeleton-Codebase-v1.1` specification and audited against
the project-local `sports-betting-prediction-audit` skill (14 categories).

> **This system estimates probabilities. It does not, and cannot, guarantee wins.**
> Betting involves risk of loss. No fabricated odds, results, ROI, or live
> integrations are present anywhere in this repository.

## What is implemented (runnable & tested locally)

| Area | Module | Notes |
|------|--------|-------|
| Taxonomy & settlement | `domain/taxonomy.py`, `domain/settlement.py` | Closed enums; per-market settlement incl. push/void/quarter-line half-win/lose |
| Events / entity integrity | `domain/events.py` | UTC-aware timestamps, stable UUID event IDs, naive-datetime rejection |
| Odds ingestion | `odds/` | Source identity, published vs ingested ts, append-only line history, stale-data rejection, consensus reconciliation |
| OpticOdds adapter | `odds/opticodds.py` | Interface + config only; **injectable transport**, no live connectivity, no secrets |
| Vig removal | `probability/implied.py` | Multiplicative, additive, Shin; two-way & multi-way; overround diagnostic |
| Features | `features/` | Explicit `as_of` joins, leakage guards, deterministic `feature_hash` |
| Modeling | `modeling/` | Temporal splits only, deterministic seeding, baselines, isotonic/Platt calibration, abstention |
| Evaluation | `evaluation/metrics.py` | Log loss, Brier, ECE, ROI+bootstrap CI, CLV, max drawdown, hit-rate CI, DM test, Bonferroni |
| Backtest | `backtest/engine.py` | At-bet-time odds, latency, slippage, rejection, limits, push/void/partial, correlated exposure |
| Risk / bankroll | `risk/bankroll.py` | Fractional Kelly, per-bet/event/market/source caps, drawdown stop, **no chase-loss** |
| Prediction API | `service/` | Strict Pydantic contract w/ uncertainty, abstain reason, timestamps, non-guarantee text |
| Chapter 8 ingestion | `ingest/handicap.py` | Signal / web (`HandicapCreate`) / OCR (`parse_handicap_image`) → `persist_handicap` |
| Security / audit | `security/audit_chain.py`, `gateway/` | Hash chain (generation == verification), L1 masking + leak detection, routing matrix |
| Responsible gambling | `responsible/gambling.py` | Disclaimer, prohibited-language scanner, age/jurisdiction gate |

## MLB + NPB league-separated models (new)

MLB and NPB share ingestion / storage / domain interfaces but keep **fully
separate** feature schemas, model artifacts, calibrators, thresholds,
settlement/tie rules and evaluation. An artifact trained for one league can never
be loaded or served for the other.

| Area | Module | Notes |
|------|--------|-------|
| Live connector | `connector/external_tool.py` | Programmatic `external-tool call` over **argv + JSON payload** (no shell interpolation); credentials injected by the runtime, never read here; typed errors (unavailable / timeout / auth / rate-limit / malformed); empty odds is a normal `[]` |
| Normalization | `connector/normalize.py` | Preserves canonical OpticOdds fixture/team ids; tolerates null NPB starters/records/venue; epoch (s/ms) → UTC; drops deep links & limits |
| League profiles | `leagues/profiles.py` | Per-league schemas (NPB carries one extra column per market), thresholds, tie rules (NPB moneyline tie ⇒ PUSH; MLB none), timezone (display only) |
| Datasets | `leagues/datasets.py` | League-isolated as-of joins (features only from odds published ≤ first pitch); labels from settlement; rows sorted ascending by cutoff; mixing leagues raises `LeagueMismatchError` |
| Pipeline | `leagues/pipeline.py` | Deterministic temporal split, dependency-free logistic model, isotonic calibration on the val slice, Brier/log-loss on test; **empty data ⇒ UNTRAINED artifact** |
| Artifacts | `leagues/artifacts.py` | League/market-tagged; sidecar `.meta.json` checked **before** unpickling; feature-width guard; UNTRAINED artifacts raise `NotReady` on predict |
| Ingestion services | `leagues/ingest.py` | Append-only immutable raw store + upsert-by-id normalized JSONL; enforces US-books-only and max-5-books-per-batch |
| CLI | `cli.py` | `handiedge <cmd> --league mlb|npb` |
| API | `service/api.py` | `GET /leagues`; `POST /leagues/{league}/predict` (unknown league ⇒ 400, cross-league/width mismatch ⇒ 409, UNTRAINED/no-artifact ⇒ 503) |

### CLI

```bash
# Live (require the external-tool connector; otherwise exit non-zero, no fake data)
handiedge sync-fixtures --league mlb
handiedge sync-odds     --league mlb --sportsbook draftkings --sportsbook fanduel
handiedge sync-results  --league mlb

# Offline (operate on locally persisted data only)
handiedge build-dataset --league mlb --market moneyline
handiedge train         --league mlb --market moneyline
handiedge evaluate      --league mlb --market moneyline
handiedge predict       --league mlb --market moneyline --features-json rows.json
```

> **Status: UNTRAINED / NotReady.** The pipelines and guards are implemented and
> tested, but no model is trained until a real historical dataset is ingested and
> acceptance metrics pass. **Synthetic data is used only in tests and is flagged
> `is_synthetic`** — no accuracy/ROI/CLV is claimed from it. The connector supports
> **US sportsbooks only** and bounded snapshots (not streaming). Japanese sportsbooks
> are **not** covered.

### Live smoke (2026-07-23) — what is and isn't live-verified

Live commands were run against the runtime `external-tool` connector with runtime-injected
credentials. **Live-verified:**

- **Fixture sync:** `sync-fixtures --league mlb` → 99 fixtures; `--league npb` → 17 fixtures.
- **NPB odds sync:** a representative NPB fixture across DraftKings + FanDuel returned non-empty
  decimal odds for all three markets (moneyline / run_line / total_runs).
- **MLB empty-odds behavior:** representative MLB fixtures (DraftKings + FanDuel, and one across
  five US books) returned `0` rows for the sampled markets. **This is normal market/book
  availability for those specific fixtures, not a connector failure — it does not mean MLB odds
  are unavailable in general.**

**NOT live-verified (do not claim):** result sync, historical dataset build, model training, and
any model performance. All league artifacts remain **UNTRAINED/NotReady**.

Two real defects were found by the smoke test and fixed (see below); the sync above passed *after*
those fixes.

> **Runtime data is not shipped.** Anything the live commands write under `HANDIEDGE_DATA_DIR`
> (default `./data`) is runtime/stale data — it may contain vendor deep links, limits, and odds
> and **must never be committed or shipped**. The `data/` tree (plus `*.npz` / `*.pkl` /
> `*.meta.json` artifacts) is gitignored. No live odds snapshot or deep link is reproduced in this
> repo or its docs.

> **Live-smoke fix #1 — missing `requests` under `uv` shebang resolution.** The runtime
> `external-tool` (shebang `#!/usr/bin/env python3`) runs under the project venv when launched via
> `uv run`, and that interpreter must be able to `import requests` (the tool's only third-party
> import). `requests>=2.32` is therefore pinned as a runtime dependency.

> **Live-smoke fix #2 — missing `odds_format=DECIMAL`.** The OpticOdds API defaults to **American**
> odds (e.g. `-172`); the request did not force a format and the normalizer strictly expects
> decimal (`> 1.0`). Fixed by always sending `odds_format: DECIMAL` on `/fixtures/odds` requests
> (callers cannot override; max-five-book rule preserved). Normalization stays strict — no silent
> American→decimal coercion.

## Represented truthfully as NOT configured / NOT ready (never faked)

AWS/Terraform, OIDC signature verification, MLflow model registry, vLLM (Kimi K3)
inference, and live LLM providers are exposed as **ports** in `ports/external.py`
and `odds/opticodds.py`. Without configuration they raise `NotConfigured` /
`NotReady`. See `AI_HANDOFF.md`.

## Setup

```bash
cd handiedge_project
uv sync --extra dev          # install pinned deps from uv.lock
cp .env.example .env         # names/placeholders only — fill in your own env
```

## Commands

```bash
uv run ruff check .          # lint
uv run ruff format --check . # format check
uv run mypy                  # type-check (package = handiedge)
uv run pytest -q             # full test suite
uv run pytest tests/test_masking.py -q   # CRITICAL L1-leak gate
```

## Layout

```
src/handiedge/
  config.py errors.py
  domain/  odds/  probability/  features/  modeling/
  evaluation/  backtest/  risk/  service/  ingest/
  security/  responsible/  gateway/  ports/
tests/
```

## Safety guarantees enforced in code

- Prohibited guaranteed-win language raises in the API contract validator.
- Splits are time-based only; a non-monotonic time input is rejected.
- Feature builder rejects naive `as_of` and never reads rows after `as_of`.
- Bankroll refuses to raise stake after a loss (`ChaseLossError`).
- Vig is removed before edge/Kelly is computed.

See `IMPLEMENTATION_AUDIT.md` for the component-by-component audit and
`HANDOFF_LOG.md` for per-component handoff entries.
