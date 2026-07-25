# HandiEdge — Handoff Log

Chronological, append-only. One entry per component per audit/implementation pass, per
`skills/sports-betting-prediction-audit/references/handoff-template.md`. Do not edit prior
entries; corrections get a new entry referencing the old one.

---

### Audit hash-chain — 2026-07-23

- **Category(ies):** 11
- **Severity:** Critical
- **Finding:** The v1.1 skeleton computed the chain hash differently on generation vs
  verification, so a correctly generated chain could fail verification (and tampering could go
  undetected). Cited: skeleton's audit module.
- **Hard rule triggered:** Auditability — generation must equal verification.
- **Fix:** Single `compute_hash(prev_hash, entry, pepper)` in `security/audit_chain.py` used by
  both `append` and `verify`; `NotConfigured` on empty pepper.
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_audit_chain.py`
  - Result: part of full-suite run below — 5 audit-chain tests pass (intact verifies, genesis
    link, tamper detected, pepper required, wrong-pepper fails).
- **Status:** Fixed & verified
- **New TODOs:** Persisting the chain to a DB is Category 12 (Blocked).

### Chapter 8 handicap ingestion — 2026-07-23

- **Category(ies):** 2
- **Severity:** High
- **Finding:** Chapter 8 (handicap ingestion) was empty in the skeleton.
- **Fix:** Implemented `ingest/handicap.py` — `HandicapCreate` (odds>1 validation, aware ts),
  `parse_signal_message`, `parse_handicap_image(gateway, image_bytes)` behind an `OCRGateway`
  port that raises `NotConfigured` when no gateway is injected, `InMemoryHandicapStore`.
- **Fix:** No live OCR/vision call is made; the gateway is injected (mock in tests).
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_ingestion.py`
  - Result: part of full-suite run below — 13 ingestion tests pass (incl. signal parse, garbage
    rejected, OCR-without-gateway raises NotConfigured, OCR with mock gateway persists).
- **Status:** Fixed & verified
- **New TODOs:** Real OCR gateway implementation when a vision provider is configured.

### Vig removal / implied probability — 2026-07-23

- **Category(ies):** 3
- **Severity:** Critical
- **Finding:** Matrix top finding — edge computed off raw implied probabilities overstates value.
- **Fix:** `probability/implied.py` with multiplicative/additive/Shin de-vig (two-way closed form
  + general iteration); `PredictionService` computes edge vs de-vigged fair prob.
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_vig.py`
  - Result: part of full-suite run below — 6 tests pass (two-way & multi-way normalisation,
    fair ≤ raw implied, Shin vs multiplicative, dispatch).
- **Status:** Fixed & verified
- **New TODOs:** None.

### Realistic backtest engine — 2026-07-23

- **Category(ies):** 8
- **Severity:** Critical
- **Finding:** Matrix top finding — naive backtests ignore availability/latency/slippage/rejects
  and overstate ROI.
- **Fix:** `backtest/engine.py` — `ExecutionModel` (latency/slippage/reject/max-stake),
  `BacktestEngine.run` decides at `signal_at + latency`, skips stale, applies slippage,
  sizes via bankroll (blocked → abstained), probabilistic rejection, settles push/void/half.
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_backtest.py`
  - Result: part of full-suite run below — 4 tests pass (stale skip, rejection, settlement into
    equity, bankroll-blocked abstain).
- **Status:** Fixed & verified
- **New TODOs:** Correlated-exposure modelling could be extended beyond current per-scope caps.

### Responsible gambling / non-guarantee — 2026-07-23

- **Category(ies):** 14
- **Severity:** Critical
- **Finding:** No guaranteed-win language guard, no jurisdiction/age gate in skeleton.
- **Hard rule triggered:** No guaranteed-win claims; mandatory RG language.
- **Fix:** `responsible/gambling.py` (prohibited-language scanner + `ResponsibleGamblingGate`),
  `NON_GUARANTEE_DISCLAIMER` in every rationale, `PredictionResponse` rejects guarantee language,
  API enforces gate (403 on blocked jurisdiction/under-age).
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_responsible.py tests/test_service_api.py`
  - Result: part of full-suite run below — RG + service tests pass (prohibited phrases flagged,
    clean language passes, jurisdiction/age gate, endpoint 403, rationale rejection).
- **Status:** Fixed & verified
- **New TODOs:** None.

### Bankroll / risk (no chase-loss) — 2026-07-23

- **Category(ies):** 9
- **Severity:** Critical
- **Finding:** Need stake caps, exposure limits, drawdown stop, and an explicit anti-chase-loss
  guard (no martingale).
- **Hard rule triggered:** No chase-loss / martingale.
- **Fix:** `risk/bankroll.py` — fractional Kelly, per-bet/event/market/source caps, drawdown stop,
  `next_stake_must_not_chase` raising `ChaseLossError`.
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_risk.py`
  - Result: part of full-suite run below — 5 tests pass.
- **Status:** Fixed & verified
- **New TODOs:** None.

### As-of features / leakage guards — 2026-07-23

- **Category(ies):** 4, 13
- **Severity:** Critical
- **Finding:** Feature joins must not read future data; splits must be temporal not random.
- **Hard rule triggered:** No data leakage; no random time-series split.
- **Fix:** `features/builder.py` (reads only data ≤ as_of, deterministic fingerprint),
  `modeling/splits.py` (`_check_sorted` rejects non-monotonic time; walk-forward/season folds).
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_features.py tests/test_splits.py`
  - Result: part of full-suite run below — 8 tests pass.
- **Status:** Fixed & verified
- **New TODOs:** None.

### External systems (registry/inference/OIDC/DB/deploy) — 2026-07-23

- **Category(ies):** 12
- **Severity:** Unverifiable (execution-dependent, no live systems here)
- **Finding:** MLflow/vLLM/OIDC/Postgres/AWS not present in this environment.
- **Fix:** Truthful ports in `ports/external.py` (`Unconfigured*` raising `NotConfigured`/reporting
  `NotReady`); `/ready` reports each dependency's real status; config reads secrets from env only.
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_service_api.py::test_health_and_ready_truthful`
  - Result: passes — `/ready` reports `ready=False` with a not-ready model_registry when nothing
    is configured. No live connectivity was attempted or claimed.
- **Status:** Proposed only (ports in place; real integrations out of scope / Blocked)
- **New TODOs:** Provide real port implementations + infra when endpoints/credentials exist.

### Live connector (`external-tool` OpticOdds) — 2026-07-23

- **Category(ies):** 2, 12
- **Severity:** Critical (a live transport is the highest-risk place to leak secrets or fabricate).
- **Finding:** MLB/NPB need bounded live odds, but no secret may be committed and no data may be
  faked when the connector is absent.
- **Hard rule triggered:** Never require/expose an OpticOdds API key; no shell interpolation;
  no fabricated odds/results.
- **Fix:** `connector/external_tool.py` — `ExternalToolClient` invokes `external-tool call` via
  **argv + a JSON payload** (no shell), transport injected as a `SubprocessRunner` Protocol
  (default `AsyncSubprocessRunner`). Envelope `{source_id, tool_name, arguments:{path, method,
  params, json_body}}`; credentials are runtime-injected (no key here). `OpticOddsConnector`
  exposes typed high-level calls and maps failures to `ConnectorUnavailable` / `ConnectorTimeout`
  / `ConnectorAuthRequired` / `ConnectorRateLimited` / `ConnectorMalformed`. Empty odds (`[]`) is a
  normal result. The request/response **shape was verified** against the runtime `external-tool`;
  no live call is made in tests.
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_connector.py tests/test_normalize.py`
  - Result: part of full-suite run below — pass (argv/no-shell, unwrap nested/wrapped output,
    empty odds, auth/rate/timeout/malformed mapping, `is_available`, real-runner missing binary →
    `ConnectorUnavailable`; normalize canonical ids/UTC, NPB null tolerance, ms epoch, price≤1
    rejected).
- **Status:** Fixed & verified (offline). **US sportsbooks only; bounded snapshots, not streaming.**
- **New TODOs:** Provide the real `external-tool` binary in the deploy environment to sync live
  data; Japanese sportsbooks are **not** covered by this connector.

### MLB + NPB league-separated models — 2026-07-23

- **Category(ies):** 1, 4, 6, 7, 13
- **Severity:** Critical (cross-league contamination and data leakage invalidate everything).
- **Finding:** MLB and NPB must not share feature schemas, artifacts, calibration, thresholds,
  tie rules or evaluation; an artifact for one league must never load for the other.
- **Hard rule triggered:** No data leakage; no random split; do not merge league populations;
  do not manufacture training data or performance.
- **Fix:** `leagues/profiles.py` (per-league schemas — NPB +1 column/market — thresholds, tie
  rules: NPB moneyline tie ⇒ PUSH, MLB none; display timezone only). `leagues/datasets.py`
  (league-isolated as-of joins: features only from odds published ≤ first pitch; labels from
  `domain.settlement`; ascending by cutoff; mixing leagues raises `LeagueMismatchError`; `.npz`
  save/load). `leagues/artifacts.py` (league/market-tagged pickle + sidecar `.meta.json` checked
  **before** unpickle; feature-width guard; UNTRAINED ⇒ `NotReady` on predict). `leagues/pipeline.py`
  (deterministic temporal split, dependency-free logistic + isotonic calibration on val,
  Brier/log-loss on test; empty/insufficient data ⇒ UNTRAINED). `leagues/ingest.py` (append-only
  immutable raw store + upsert-by-id normalized JSONL; US-books-only, ≤5 books/batch).
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_leagues.py`
  - Result: part of full-suite run below — pass (distinct schemas, differing settlement,
    mixed-league rejection, anti-leakage post-start drop → n==0, NPB tie drop → n==0, UNTRAINED
    predict raises `NotReady`, misfiled-artifact → `LeagueMismatchError`/409, feature-width
    mismatch → 409, empty train → UNTRAINED, metrics + synthetic flag, cross-league predictor
    rejection, schema-mismatch train rejection).
- **Status:** Fixed & verified — **UNTRAINED/NotReady.** No model trained; synthetic data is
  test-only and flagged `is_synthetic`. **No accuracy/ROI/CLV is claimed.**
- **New TODOs:** Ingest a real historical dataset and pass acceptance metrics before quoting any
  performance number.

### League CLI + API — 2026-07-23

- **Category(ies):** 10, 12
- **Severity:** High.
- **Finding:** Operators need per-league commands/endpoints that fail truthfully when the
  connector or an artifact is missing, and reject cross-league/unknown requests.
- **Fix:** `cli.py` — `handiedge <cmd> --league mlb|npb` (sync-fixtures/odds/results are live and
  exit non-zero with `connector unavailable` when `external-tool` is absent; build-dataset/train/
  evaluate/predict are offline; `--synthetic` flag flows to the artifact meta). `service/api.py` —
  `GET /leagues`; `POST /leagues/{league}/predict` (unknown league ⇒ 400, cross-league/width
  mismatch ⇒ 409, UNTRAINED/no-artifact ⇒ 503).
- **Verification:**
  - Command(s) run: `uv run pytest tests/test_cli.py tests/test_service_league.py`
  - Result: part of full-suite run below — pass (connector-unavailable exit 4; offline build/train/
    evaluate/predict on seeded synthetic data; unknown league exit 1; `/leagues` lists both;
    unknown → 400; no artifact → 503; trained serves; width → 409; cross-league misfiled → 409).
- **Status:** Fixed & verified.
- **New TODOs:** None.

### Live-smoke: `external-tool` interpreter/dependency failure — 2026-07-23

- **Category(ies):** 2, 12, 13
- **Severity:** High (a real integration failure surfaced by a live smoke test).
- **Finding:** `uv run handiedge sync-fixtures --league mlb` exited 5 with the connector reporting
  `external-tool exited 1 ... import requests ... ModuleNotFoundError: No module named 'requests'`.
- **Diagnosis:** The runtime `external-tool` binary is a Python script with shebang
  `#!/usr/bin/env python3`; its only third-party import is `requests` (all others are stdlib).
  `uv run` prepends `.venv/bin` to `PATH`, so `env python3` resolves to the project venv's
  interpreter (python3.14) rather than the system interpreter (which has `requests 2.34.2`). The
  venv lacked `requests`, so the tool failed at import — before any network call. The connector
  correctly mapped the nonzero exit to `ConnectorError` → CLI exit 5 (no crash, no fabrication).
- **Fix:** Pinned `requests>=2.32` as a **project runtime dependency** (justified: it is the sole
  third-party module the injected connector imports, and under `uv run` the tool executes with the
  venv interpreter). No PATH rewriting, no shell interpolation, no credential handling changed.
  `uv.lock` updated (`requests 2.34.2`, `urllib3`, `charset-normalizer`, `certifi`/`idna` pulled in).
- **Verification:**
  - `uv run external-tool` (no args) now prints the usage banner instead of `ModuleNotFoundError`
    (safe probe — usage runs after imports, makes no network call).
  - `.venv/bin/python3 -c "import requests"` → `2.34.2`.
  - Regression tests in `tests/test_connector.py`:
    `test_runtime_interpreter_can_import_requests` (spawns the venv interpreter via the real
    `AsyncSubprocessRunner` and asserts `import requests` succeeds — would have failed pre-fix) and
    `test_missing_runtime_dependency_maps_to_connector_error` (a `ModuleNotFoundError` exit maps to
    a typed `ConnectorError`).
- **Status:** Fixed & verified at the dependency/interpreter and error-mapping level. **The live
  call itself is NOT claimed to succeed** — the operator will rerun `sync-fixtures` after this fix.
- **New TODOs:** Confirm the end-to-end live sync once rerun with runtime credentials.

### Live-smoke: NPB odds rejected — American vs decimal odds format — 2026-07-23

- **Category(ies):** 2, 3, 13
- **Severity:** High (a real integration failure surfaced by a live smoke test; MLB happened to
  return 0 rows so it was silent, NPB exposed it).
- **Finding:** `sync-odds` for NPB failed with `error: decimal price must be > 1.0, got -172.0`.
  MLB returned 0 rows (normal) and so did not trip it.
- **Diagnosis:** The OpticOdds API defaults to **American** odds (e.g. `-172`) when the request does
  not specify a format. The live `/fixtures/odds` request omitted `odds_format`, so the connector
  received American prices, while `connector/normalize.py` correctly and strictly expects **decimal**
  prices (> 1.0). The normalizer did the right thing by rejecting the American value rather than
  guessing — the defect was on the request side.
- **Fix (minimal, at the request boundary):** `OpticOddsConnector.fixture_odds` now always includes
  `"odds_format": "DECIMAL"` in the request params, so every ingestion/CLI path forces decimal.
  Caller params (league, fixture_id, sportsbook, market) and the max-five-book rule are preserved;
  callers cannot override the format. **Normalization stays strict** — no silent American→decimal
  coercion was added; arbitrary negative prices are still rejected.
- **Verification:**
  - `tests/test_connector.py::test_fixture_odds_request_forces_decimal_format` — asserts the
    outgoing request contains `odds_format: DECIMAL` and preserves the caller's other params.
  - `tests/test_normalize.py::test_odds_reject_american_negative_price_not_decimal` — asserts a
    `-172.0` price is rejected (not accepted as decimal).
- **Status:** Fixed & verified at the request-shape and normalization level. **The live call itself
  is NOT claimed to succeed** — the operator will rerun `sync-odds` after this fix.
- **New TODOs:** Confirm end-to-end live NPB/MLB odds sync once rerun with runtime credentials.

### Live smoke — end-to-end sync CONFIRMED (supersedes the two "not claimed" statuses above) — 2026-07-23

- **Category(ies):** 2, 12, 13
- **Severity:** Informational (verification of prior fixes).
- **Finding:** After fixes #1 (pinned `requests`) and #2 (forced `odds_format: DECIMAL`), the
  operator reran the live commands with runtime-injected credentials and they **succeeded**. This
  entry supersedes the "live call is NOT claimed to succeed" statuses in the two entries above.
- **Actual results (live-verified):**
  - `uv run handiedge sync-fixtures --league mlb` → `synced 99 mlb fixtures`.
  - `uv run handiedge sync-fixtures --league npb` → `synced 17 npb fixtures`.
  - Representative NPB fixture, DraftKings + FanDuel: moneyline 4 rows, run_line 36 rows,
    total_runs 36 rows (non-empty decimal odds).
  - Representative MLB fixture, DraftKings + FanDuel: all three markets 0 rows. A second MLB
    fixture across five US books: moneyline 0 rows. This is **normal market/book availability for
    the sampled fixtures**, not a connector failure — it does **not** imply MLB odds are
    unavailable generally, and the MLB empty-`[]` path is itself live-verified.
- **Explicitly NOT live-verified (no claims):** result sync, historical dataset build, model
  training, and any model performance. All league artifacts remain **UNTRAINED/NotReady**.
- **Data handling:** live commands write runtime/stale snapshots under `HANDIEDGE_DATA_DIR`
  (default `./data`); this data may contain vendor deep links/limits/odds and **must never be
  committed or shipped**. The `data/` tree (and `*.npz`/`*.pkl`/`*.meta.json`) is gitignored. No
  live odds snapshot or deep link is reproduced in this repo or its docs.
- **Verification:** operator-run live commands (above); no fixture data was copied into the repo.
- **Status:** Live-verified for fixture sync (MLB+NPB), NPB odds sync, and MLB empty-odds behavior.
- **New TODOs:** Result sync + historical dataset + training/eval still need live verification and
  a real dataset before any performance is quoted.

---

## Acceptance Gate — 2026-07-23 (league-separated pass)

Environment: Python 3.14, uv. All commands run in this session.

| # | Command | Purpose | Result |
|---|---------|---------|--------|
| 1 | `uv sync --extra dev` | Install pinned deps (uv.lock, incl. requests) | pass |
| 2 | `uv run ruff check .` | Lint | pass — "All checks passed!" |
| 3 | `uv run ruff format --check .` | Formatting | pass — "74 files already formatted" |
| 4 | `uv run mypy` | Type safety | pass — "Success: no issues found in 55 source files" |
| 5 | `uv run pytest` | Unit + integration (incl. leakage/masking/audit/leagues/connector-dep/odds-format) | pass — "138 passed, 1 warning" |

**Overall status:** All rows pass with real output shown above. The only warning is a benign
`StarletteDeprecationWarning` about httpx in the FastAPI TestClient (does not affect results).

**Non-claims:** No live external integration or deployment was executed; Category 12 remains
Blocked behind truthful ports. The `external-tool` connector shape was **verified** but no live
call is made here and no synced data ships. League pipelines are **UNTRAINED/NotReady**; synthetic
data is test-only and flagged `is_synthetic`. No odds/ROI/calibration/deployment results are
fabricated, and no OpticOdds API key is present.
