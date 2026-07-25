# AI Handoff — HandiEdge

Date: 2026-07-23. Purpose: give the next agent/engineer the canonical naming map, the open
TODOs/blockers, the acceptance gates, and the hard rule on completion claims.

## Hard completion rule (read first)

**Do NOT claim the project (or any external integration or deployment) is "complete" or
"production-ready" until every acceptance-gate command below has been run in your session and
shown a real passing result.** External integrations (Category 12) must never be described as
working unless a real endpoint + credential was configured and exercised — this repo ships those
as truthful `NotConfigured`/`NotReady` ports, not implementations.

## Canonical naming map (from v1.1 skeleton spec)

| Concept | Canonical name in this repo |
|---|---|
| OCR task type | `TaskType.OCR` (`gateway/types.py`) |
| Handicap image parse | `parse_handicap_image(gateway, image_bytes)` (`ingest/handicap.py`) |
| Handicap input model | `HandicapCreate` (`ingest/handicap.py`) |
| Signal message parse | `parse_signal_message(message)` (`ingest/handicap.py`) |
| Router selection | `Router().pick(task, classification)` (`gateway/router.py`) |
| L1 → provider pin | all L1 routes → `ProviderName.KIMI_K3` (import-time assertion) |
| Default LLM model | `deepseek-v4-pro` (`Settings.default_llm_model`) |
| Settings factory | `get_settings(**overrides)` (no global singleton) |
| Fair-prob de-vig | `remove_vig(odds, method=...)` (`probability/implied.py`) |
| Decision contract | `PredictionResponse` / `Decision.BET|ABSTAIN` (`service/contracts.py`) |
| Audit hash | single `compute_hash(prev_hash, entry, pepper)` (`security/audit_chain.py`) |

Environment variables use prefix `HANDIEDGE_` (see `.env.example` for the exact names).

## Architecture decisions

- **Pure-Python domain core** (numpy/scipy/pydantic/fastapi). Heavy/unavailable deps
  (Postgres, SQLAlchemy, LightGBM, Optuna, MLflow, vLLM) are intentionally **not** dependencies;
  they are represented as ports.
- **Calibration in numpy** (isotonic PAVA + Platt) — no sklearn.
- **Ports pattern** for all external systems with `NotConfigured`/`NotReady` (`ports/external.py`).
- **Edge = model_prob − de-vigged fair prob** (never vs raw implied).
- **Temporal splits only**; random splits are rejected by `_check_sorted`.
- **Single audit hash function** shared by generation and verification (fixes v1.1 mismatch).

### MLB + NPB league separation (new)

- **Shared interfaces, isolated artifacts.** MLB and NPB reuse ingestion/storage/domain code but
  have **separate** feature schemas, model artifacts, calibrators, thresholds, tie rules and
  evaluation. Cross-league loads are refused two ways: a league tag in the sidecar `.meta.json`
  (checked **before** unpickle → `LeagueMismatchError`) **and** a feature-width guard (NPB carries
  one extra column per market). An MLB artifact can never be loaded or served for NPB.
- **Live connector via runtime `external-tool`** (`connector/external_tool.py`): programmatic
  `external-tool call` over **argv + a JSON payload** — no shell interpolation. Credentials are
  **injected by the runtime**; there is **no OpticOdds API key** in this repo by design. Typed
  errors: unavailable / timeout / auth-required / rate-limit / malformed. Empty odds (`[]`) is a
  normal outcome, never fabricated. Transport is an injectable `SubprocessRunner` Protocol so tests
  run fully offline via a `FakeRunner`. **US sportsbooks only; bounded snapshots, not streaming.**
- **As-of league-isolated datasets** (`leagues/datasets.py`): features come only from odds
  published ≤ first pitch; labels from `domain.settlement`; NPB moneyline tie ⇒ PUSH ⇒ unlabelable
  and dropped. Mixing leagues raises `LeagueMismatchError`.
- **UNTRAINED by default.** `leagues/pipeline.py` trains a dependency-free logistic model with
  isotonic calibration on a deterministic temporal split, but empty/insufficient real data yields
  an **UNTRAINED** artifact that raises `NotReady` on predict. Synthetic data is used **only in
  tests** and is flagged `is_synthetic`; **no accuracy/ROI/CLV is claimed from it.**

## Open TODOs / blockers

1. **Category 12 external systems (Blocked):** provide real implementations of
   `ModelRegistryPort`, `InferenceServerPort`, `OIDCVerifierPort` and a DB-backed audit-chain
   store when endpoints/credentials exist. Wire via `HANDIEDGE_*` env.
2. **OpticOdds live transport:** two paths. (a) The legacy `OpticOddsAdapter` takes an injected
   HTTP transport + `HANDIEDGE_OPTICODDS_*`. (b) The new `connector/external_tool.py` calls the
   runtime `external-tool` connector (argv + JSON payload, credentials runtime-injected, **no API
   key**). When the binary is absent, live CLI commands print `connector unavailable` and exit
   non-zero. **US sportsbooks only.**
   - **Live smoke SUCCEEDED (2026-07-23), after the two fixes below.** With runtime-injected
     credentials: `sync-fixtures --league mlb` → **99 fixtures**; `--league npb` → **17 fixtures**.
     A representative NPB fixture across DraftKings + FanDuel returned non-empty decimal odds for
     all three markets (moneyline / run_line / total_runs). Representative MLB fixtures (DK+FD, and
     one across five US books) returned **0 rows** for the sampled markets — normal market/book
     availability for those fixtures, **not** a connector failure and **not** a claim that MLB odds
     are unavailable in general. **Live-verified:** fixture sync (MLB+NPB), NPB odds sync, and the
     MLB empty-`[]` odds path. **NOT live-verified:** result sync, dataset build, training, model
     performance. Any data written under `HANDIEDGE_DATA_DIR` is runtime/stale and **must not be
     committed or shipped** (the `data/` tree is gitignored); no live odds/deep links are in docs.
   - **Live-smoke fix #1 (2026-07-23):** `sync-fixtures --league mlb` first exited 5 with
     `ModuleNotFoundError: No module named 'requests'` from the tool. Root cause: the
     `external-tool` shebang is `#!/usr/bin/env python3`; `uv run` prepends `.venv/bin` to `PATH`,
     so the tool runs under the project venv interpreter, which lacked `requests`. **Fix:** pinned
     `requests>=2.32` as a project runtime dependency (the *only* third-party import the tool
     needs). No PATH/credential manipulation, no shell interp. Regression tests in
     `tests/test_connector.py`.
   - **Live-smoke fix #2 (2026-07-23):** NPB `sync-odds` then failed with `decimal price must be
     > 1.0, got -172.0`. Root cause: the OpticOdds API defaults to **American** odds, but the live
     `/fixtures/odds` request did not force a format, while the normalizer strictly expects decimal.
     **Fix:** `OpticOddsConnector.fixture_odds` now always sends `odds_format: DECIMAL` (callers
     cannot override; other params + max-5-book rule preserved). Normalization stays strict — no
     silent American→decimal coercion. Regression tests in `tests/test_connector.py` and
     `tests/test_normalize.py`.
3. **Model training:** numpy baselines + the league logistic pipeline ship, but no model is
   trained. All league artifacts are **UNTRAINED/NotReady** until a **real historical dataset** is
   ingested and acceptance metrics pass. Synthetic data is test-only and flagged `is_synthetic`;
   **no accuracy/ROI/CLV is claimed.** Gradient-boosted models + Optuna remain out of scope
   (would need LightGBM/Optuna added as deps).
4. **Deployment (AWS/Terraform/OIDC):** not implemented, not verifiable here — leave as design
   ports until infra exists.
5. **httpx/starlette TestClient deprecation warning** is benign; revisit when upgrading FastAPI.

## Acceptance gates

Run all of these; all must exit 0 before any completion claim. Real outputs from this session are
pasted in [HANDOFF_LOG.md](HANDOFF_LOG.md).

| # | Command | Purpose |
|---|---------|---------|
| 1 | `uv sync --extra dev` | Install pinned deps (uv.lock) |
| 2 | `uv run ruff check .` | Lint |
| 3 | `uv run ruff format --check .` | Formatting |
| 4 | `uv run mypy` | Type safety |
| 5 | `uv run pytest` | Unit + integration tests (incl. leakage/masking/audit) |

## Safety invariants (must remain true)

- No guaranteed-win language anywhere; `PredictionResponse` rejects it at the boundary.
- Every prediction rationale carries `NON_GUARANTEE_DISCLAIMER`.
- Jurisdiction + age gate enforced before any pick is returned by the API.
- No fabricated odds / ROI / calibration / deployment / live-API results.
- No secret values in the repo; `.env.example` is names/placeholders only.
- Probability quality (log loss/Brier/ECE) is reported separately from profitability (ROI/CLV).
