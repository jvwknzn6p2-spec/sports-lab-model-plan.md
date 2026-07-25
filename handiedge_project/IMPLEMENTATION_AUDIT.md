# HandiEdge — Implementation Audit

Date: 2026-07-23. Auditor: automated implementation pass against
`skills/sports-betting-prediction-audit/SKILL.md` and `SPORTS_BETTING_AUDIT_MATRIX.md`.

This document records, per component: **inspect → severity → fix → implementation → tests →
handoff**, and classifies each as **Implemented**, **Partial**, **Blocked**, or **Unverified**.

## How to read this

- **Implemented** = code exists in this repo and is exercised by passing tests in this session.
- **Partial** = core logic implemented; some realistic extension deferred (noted).
- **Blocked** = requires an external system/credential not available here; represented by an
  explicit port with truthful `NotConfigured` / `NotReady` behaviour (no fake implementation).
- **Unverified** = cannot be verified by execution in this environment (e.g. live deployment).

Acceptance-gate command outputs are in [HANDOFF_LOG.md](HANDOFF_LOG.md). All checks pass as of
this session: `ruff check` clean, `ruff format --check` clean, `mypy` 0 issues (55 files),
`pytest` 138 passed.

---

## Category 1 — Data model / taxonomy — **Implemented**

- **Inspect:** Need canonical sport/league/event/market/selection + settlement-rule models with
  timezone-safe timestamps.
- **Severity (pre-fix):** High (a weak core propagates errors everywhere).
- **Fix / implementation:** `domain/taxonomy.py` (Sport, MarketType, Side, SettlementResult,
  league validation), `domain/events.py` (frozen `Event`/`Market`/`Selection`/`EventOutcome`,
  `require_aware` rejects naive datetimes and normalises to UTC), `domain/settlement.py`
  (`settle` handling WIN/LOSE/PUSH/HALF_WIN/HALF_LOSE/VOID incl. quarter handicap lines; `pnl`).
- **Tests:** `test_settlement.py` (10) — spreads, totals, moneyline two/three-way, quarter lines,
  push/void, half-win/half-lose PnL, odds<=1 guard.
- **Handoff:** No blockers.

## Category 2 — Odds ingestion & line history — **Implemented**

- **Inspect:** Source/bookmaker identity, timestamps, event IDs, validation, **stale-data
  rejection**, append-only line history, OpticOdds adapter with no secrets / no live claim.
- **Severity (pre-fix):** Critical (stale odds and silent overwrite are decision-corrupting).
- **Fix / implementation:** `odds/models.py` (`OddsQuote` aware-ts validation, `LineHistory`
  append-only sorted, opening/closing/as-of), `odds/ingestion.py` (`validate_quote`,
  `OddsIngestor` with `.failures`, `quote_for_decision` raising `StaleDataError`,
  `consensus_line` median), `odds/opticodds.py` (`OpticOddsConfig.from_settings` raises
  `NotConfigured`; `OpticOddsAdapter` with **injected transport** — no network, no secret values).
- **Tests:** `test_ingestion.py` (13) — stale rejected / fresh accepted, invalid odds recorded as
  failure, append-only + median consensus, naive-datetime rejected, OpticOdds mock transport,
  unknown-market rejection; plus Chapter 8 (below).
- **Handoff:** Live OpticOdds connectivity is **Blocked** (needs base URL + key) — adapter is ready
  behind config; supply `HANDIEDGE_OPTICODDS_*` to use it.

## Category 3 — Implied probability & vig removal — **Implemented**

- **Inspect:** Robust overround removal for two-way and multi-way; edge computed vs de-vigged
  fair prob, never raw implied.
- **Severity (pre-fix):** Critical (matrix top finding — edge off raw implied over-states value).
- **Fix / implementation:** `probability/implied.py` — `remove_vig_multiplicative`,
  `remove_vig_additive`, `remove_vig_shin` (2-way closed form + general fixed-point), dispatcher
  requiring ≥2 outcomes; `FairProbabilities` validates normalisation. `PredictionService` computes
  `edge = model_prob − fair_market_prob`.
- **Tests:** `test_vig.py` (6) — two-way and multi-way sum-to-one, fair ≤ raw implied, Shin vs
  multiplicative, method dispatch.
- **Handoff:** No blockers.

## Category 4 — As-of features & leakage guards — **Implemented**

- **Inspect:** Feature joins must only read data with timestamp ≤ as_of; deterministic fingerprint.
- **Severity (pre-fix):** Critical (leakage invalidates all downstream metrics — hard rule).
- **Fix / implementation:** `features/store.py` (`core4_picks_before` filters `submitted_at <
  as_of`), `features/builder.py` (`FeatureBuilder.build` reads only lines ≤ as_of, rejects naive
  as_of, `FeatureVector.fingerprint()` = SHA256 of sorted JSON).
- **Tests:** `test_features.py` (4) — future line/pick excluded, naive as_of rejected, fingerprint
  deterministic & sensitive to inputs.
- **Handoff:** No blockers.

## Category 5 — Data masking / L1 leak detection — **Implemented**

- **Inspect:** Sensitive L1 fields must never leave the gateway; routing must pin L1 to KIMI_K3.
- **Severity (pre-fix):** High.
- **Fix / implementation:** `gateway/types.py` (Classification, L1_FIELDS), `gateway/masking.py`
  (`mask` strips L1 recursively, `verify_no_leak` raises `LeakDetectedError` on L1 key or hash-like
  token), `gateway/router.py` (import-time assertion that all L1 routes → KIMI_K3).
- **Tests:** `test_masking.py` (5) — L1 stripped, hash token detected, clean payload passes,
  routing pins L1.
- **Handoff:** Actual provider calls are **Blocked** (no endpoints/keys); only masking + routing
  logic is exercised.

## Category 6 — Modeling: splits, seeding, baselines, calibration, abstention — **Implemented**

- **Inspect:** Temporal (not random) splits, deterministic seeding, baselines, calibration,
  abstention with reason codes.
- **Severity (pre-fix):** Critical (random time-series split is a hard-rule violation).
- **Fix / implementation:** `modeling/splits.py` (`walk_forward`, `season_folds`,
  `temporal_train_val_test`; `_check_sorted` rejects non-monotonic time), `modeling/seeding.py`
  (`set_global_seed`, `rng`), `modeling/baselines.py` (`MarketImpliedBaseline`, `AlwaysBaseProb`,
  numpy `LogisticRegression`), `modeling/calibration.py` (`IsotonicCalibrator` PAVA,
  `PlattCalibrator`), `modeling/abstention.py` (`AbstentionPolicy` → reason codes).
- **Tests:** `test_splits.py` (4), `test_modeling.py` (6) — deterministic seed, logistic learns
  separable, market baseline, isotonic monotone + improves Brier, Platt runs, abstention reasons.
- **Handoff:** Gradient-boosted models / Optuna are **not** included (would need LightGBM/Optuna);
  numpy baselines fill the interface and keep the repo runnable offline.

## Category 7 — Evaluation metrics — **Implemented**

- **Inspect:** Log loss, Brier, calibration error, ROI+CI, CLV, max drawdown; separate
  probability quality from profitability.
- **Severity (pre-fix):** High.
- **Fix / implementation:** `evaluation/metrics.py` — `log_loss`, `brier_score`,
  `expected_calibration_error`, `hit_rate_with_ci` (Wilson), `roi_with_ci` (bootstrap, fixed seed),
  `clv`, `max_drawdown`, `diebold_mariano`, `bonferroni`.
- **Tests:** `test_metrics.py` (8) — known-value checks, ECE bins, ROI CI ordering, CLV sign,
  drawdown, DM.
- **Handoff:** No blockers. Metrics operate on supplied arrays; no fabricated results are stored.

## Category 8 — Realistic backtest engine — **Implemented**

- **Inspect:** Availability, latency/slippage, rejected bets, limits, pushes/voids/partial
  settlement, correlated exposure.
- **Severity (pre-fix):** Critical (matrix top finding — naive backtest overstates ROI).
- **Fix / implementation:** `backtest/engine.py` — `ExecutionModel` (latency, slippage, reject
  prob, max stake), `BacktestEngine.run` uses `quote_for_decision` at `signal_at + latency`
  (stale → skipped), applies slippage, sizes via `BankrollManager` (blocked → abstained),
  probabilistic rejection, settles with push/void/half handling.
- **Tests:** `test_backtest.py` (4) — stale skip, rejection path, settlement into equity, abstain
  when bankroll blocks.
- **Handoff:** No blockers. All inputs are caller-supplied; engine fabricates no odds or outcomes.

## Category 9 — Bankroll / risk policy — **Implemented**

- **Inspect:** Stake caps, exposure limits (event/market/source), drawdown stop, **no chase-loss**.
- **Severity (pre-fix):** Critical (chase-loss/martingale is a hard-rule violation).
- **Fix / implementation:** `risk/bankroll.py` — `kelly_fraction` clamped ≥0, `RiskPolicy`
  (fractional Kelly + per-bet/event/market/source caps + drawdown stop), `BankrollManager`
  (exposure ledgers, `.stopped`, `size_bet`, `commit`, `settle`), `next_stake_must_not_chase`
  raises `ChaseLossError`.
- **Tests:** `test_risk.py` (5) — Kelly value/clamp, caps enforced, drawdown stop, chase-loss guard.
- **Handoff:** No blockers.

## Category 10 — Prediction service & API contracts — **Implemented**

- **Inspect:** Probability, uncertainty, abstain/reason codes, timestamps, non-guarantee language.
- **Severity (pre-fix):** High.
- **Fix / implementation:** `service/contracts.py` (`PredictionResponse` with `_no_guarantee`
  rationale validator + `_coherent` decision validator), `service/prediction.py`
  (`PredictionService.predict` full pipeline), `service/api.py` (`create_app`: `/health`,
  truthful `/ready`, `/predict` with RG enforce → 403 / 503 no-service / 404 no-event,
  `/internal/metrics` key-gated, docs disabled in prod).
- **Tests:** `test_service_api.py` (7) — BET emits disclaimer + kelly, abstain on no-edge,
  rationale rejects guarantee language, health/ready truthful, metrics key required, jurisdiction
  block at endpoint, docs 404 in prod.
- **Handoff:** No blockers for the offline path (injected model). Live model registry/inference is
  Category 12 (Blocked).

## Category 11 — Audit hash-chain — **Implemented**

- **Inspect:** Generation and verification must use the same algorithm; tampering detected; pepper
  required.
- **Severity (pre-fix):** Critical (the v1.1 skeleton had a **gen≠verify mismatch**).
- **Fix / implementation:** `security/audit_chain.py` — single `compute_hash(prev, entry, pepper)`
  used by both append and verify; `AuditChain` raises `NotConfigured` on empty pepper; `verify`
  returns broken indices.
- **Tests:** `test_audit_chain.py` (5) — intact chain verifies, genesis link, tamper detected,
  pepper required, wrong-pepper chain fails.
- **Handoff:** No blockers. Persistence of the chain to a DB is Category 12 (Blocked).

## Category 12 — External systems (registry/inference/OIDC/DB/deploy) — **Blocked (truthful)**

- **Inspect:** MLflow registry, vLLM inference, OIDC, Postgres, AWS/Terraform, MinIO.
- **Severity:** Unverifiable by execution here.
- **Fix / implementation:** `ports/external.py` — Protocols + `Unconfigured*` implementations that
  raise `NotConfigured`/report `NotReady`; `config.py` reads endpoints/secrets from env only.
  `/ready` reports each dependency truthfully as not-ready when unconfigured.
- **Tests:** `test_service_api.py::test_health_and_ready_truthful` asserts `/ready` reports
  `ready=False` with a `not_ready` model_registry when nothing is configured.
- **Handoff:** **Blocked — no live integration or deployment is claimed.** To enable: set the
  corresponding `HANDIEDGE_*` env vars and provide real port implementations. No fabricated
  connectivity, credentials, or deployment results are present.

## Category 13 — Determinism / reproducibility — **Implemented**

- **Inspect:** Fixed seeds, deterministic feature fingerprint, reproducible bootstrap CIs.
- **Severity (pre-fix):** Medium.
- **Fix / implementation:** `modeling/seeding.py` (DEFAULT_SEED), fixed seed in `roi_with_ci`,
  `FeatureVector.fingerprint()`.
- **Tests:** `test_modeling.py::test_deterministic_seed`, `test_features.py` fingerprint checks.
- **Handoff:** No blockers.

## Category 14 — Responsible gambling / non-guarantee — **Implemented**

- **Inspect:** Prohibited guaranteed-win language blocked; jurisdiction + age gates; mandatory
  disclaimer.
- **Severity (pre-fix):** Critical (hard rule — no guaranteed-win claims).
- **Fix / implementation:** `responsible/gambling.py` — `scan_prohibited_language` /
  `assert_no_guarantee_language` (guaranteed win/profit, sure thing, lock, can't lose, risk-free,
  beat the book, 100% accurate, no risk), `ResponsibleGamblingGate` (blocked-list precedence, then
  allow-list, then age). `NON_GUARANTEE_DISCLAIMER` embedded in every rationale.
  `PredictionResponse` rejects guarantee language at the contract boundary.
- **Tests:** `test_responsible.py` (4, parametrized to 6+ phrases), `test_service_api.py`
  jurisdiction block + rationale rejection.
- **Handoff:** No blockers.

---

## MLB + NPB league-separated models — **Implemented (UNTRAINED/NotReady)**

Spans categories 1, 2, 4, 6, 7, 10, 12, 13. MLB and NPB reuse ingestion/storage/domain code but
keep **fully separate** feature schemas, artifacts, calibrators, thresholds, settlement/tie rules
and evaluation. An artifact trained for one league can never be loaded or served for the other.

- **Live connector — Implemented (offline-verified).** `connector/external_tool.py` invokes the
  runtime `external-tool` connector via **argv + a JSON payload** (no shell interpolation);
  transport is an injectable `SubprocessRunner` Protocol (default `AsyncSubprocessRunner`, tests use
  `FakeRunner`). Envelope `{source_id, tool_name, arguments:{path, method, params, json_body}}`;
  **credentials are runtime-injected — there is no OpticOdds API key in this repo.** Typed errors:
  `ConnectorUnavailable`/`ConnectorTimeout`/`ConnectorAuthRequired`/`ConnectorRateLimited`/
  `ConnectorMalformed`; empty odds (`[]`) is a normal outcome. `connector/normalize.py` preserves
  canonical fixture/team ids, tolerates null NPB starters/records/venue, converts s/ms epoch → UTC,
  and drops deep links/limits. Tests: `test_connector.py`, `test_normalize.py`. **US sportsbooks
  only; bounded snapshots, not streaming — Japanese sportsbooks are not covered.** **Live-verified
  (2026-07-23):** with runtime-injected credentials, `sync-fixtures` returned 99 MLB and 17 NPB
  fixtures, a representative NPB fixture returned non-empty decimal odds across all three markets,
  and the MLB empty-`[]` odds path was exercised (0 rows for the sampled fixtures is normal
  market/book availability, not a connector failure). No live odds snapshot or deep link is
  reproduced in this repo. Tests remain fully offline via `FakeRunner`.
- **League profiles & isolation — Implemented.** `leagues/profiles.py` (per-league schemas — NPB
  carries one extra column per market — thresholds, tie rules: NPB moneyline tie ⇒ PUSH, MLB none;
  display timezone only, UTC persisted). `leagues/artifacts.py` tags each artifact with league +
  market and writes a sidecar `.meta.json` **checked before unpickle** (→ `LeagueMismatchError`),
  plus a feature-width guard; UNTRAINED artifacts raise `NotReady` on predict.
- **As-of datasets — Implemented.** `leagues/datasets.py` builds league-isolated as-of joins
  (features only from odds published ≤ first pitch; labels from `domain.settlement`; rows ascending
  by cutoff; mixing leagues raises `LeagueMismatchError`; `.npz` save/load).
- **Pipeline — Implemented (UNTRAINED).** `leagues/pipeline.py` runs a deterministic temporal split,
  a dependency-free logistic model and isotonic calibration on the val slice, Brier/log-loss on
  test; **empty/insufficient real data ⇒ UNTRAINED artifact**.
- **Ingestion services — Implemented.** `leagues/ingest.py` — append-only immutable raw store +
  upsert-by-id normalized JSONL; enforces US-books-only and max-5-books-per-batch.
- **CLI & API — Implemented.** `cli.py` (`handiedge <cmd> --league mlb|npb`; live commands exit
  non-zero when `external-tool` is absent, never fabricating data). `service/api.py`
  (`GET /leagues`; `POST /leagues/{league}/predict` — unknown league ⇒ 400, cross-league/width
  ⇒ 409, UNTRAINED/no-artifact ⇒ 503).
- **Tests:** `test_leagues.py`, `test_cli.py`, `test_service_league.py` — distinct schemas,
  differing settlement, mixed-league rejection, anti-leakage post-start drop (n==0), NPB tie drop
  (n==0), UNTRAINED predict raises, misfiled/cross-league artifact → `LeagueMismatchError`/409,
  feature-width mismatch → 409, connector-unavailable exit code, offline build/train/evaluate/
  predict on synthetic data.
- **Handoff — honesty:** **No model is trained.** Synthetic data is used **only in tests** and is
  flagged `is_synthetic`; **no accuracy/ROI/CLV is claimed.** Ingest a real historical dataset and
  pass acceptance metrics before quoting any performance number.

---

## Summary table

| Category | Component | Status |
|---|---|---|
| 1 | Domain taxonomy / settlement | Implemented |
| 2 | Odds ingestion + line history (+ OpticOdds adapter) | Implemented (live conn Blocked) |
| 3 | Implied prob + vig removal | Implemented |
| 4 | As-of features + leakage guards | Implemented |
| 5 | Masking / L1 leak detection + routing | Implemented (provider calls Blocked) |
| 6 | Splits / seeding / baselines / calibration / abstention | Implemented |
| 7 | Evaluation metrics | Implemented |
| 8 | Realistic backtest engine | Implemented |
| 9 | Bankroll / risk (no chase-loss) | Implemented |
| 10 | Prediction service + API contracts | Implemented |
| 11 | Audit hash-chain | Implemented (gen=verify fixed) |
| 12 | Registry / inference / OIDC / DB / deploy | **Blocked (truthful ports)** |
| 13 | Determinism | Implemented |
| 14 | Responsible gambling / non-guarantee | Implemented |
| 1,2,4,6,7,10,12,13 | MLB + NPB league-separated models (connector/profiles/datasets/pipeline/ingest/CLI/API) | Implemented (**UNTRAINED/NotReady**; live connector fixture/odds sync live-verified 2026-07-23) |

## Matrix top-findings — confirmation

- **Chapter 8 (was empty):** now implemented in `ingest/handicap.py` (`HandicapCreate`,
  `parse_signal_message`, `parse_handicap_image` behind an `OCRGateway` port raising
  `NotConfigured`, `InMemoryHandicapStore`) with tests in `test_ingestion.py`. **Covered.**
- **Vig removal:** implemented in `probability/implied.py` (multiplicative/additive/Shin) with
  two-way and multi-way tests. **Covered.**
- **Realistic backtesting:** implemented in `backtest/engine.py` (latency, slippage, rejects,
  stale skips, push/void, bankroll-blocked abstain). **Covered.**
- **Responsible-gambling gaps:** implemented in `responsible/gambling.py` + contract validator +
  API gate. **Covered.**

## Explicit non-claims (honesty)

- No live OpticOdds / MLflow / vLLM / OIDC / Postgres / AWS connectivity is implemented or claimed.
- No odds, ROI, calibration, or deployment results are fabricated; all metrics run on
  caller-supplied data.
- No credentials or secret values are stored; `.env.example` holds names/placeholders only.
- The `external-tool` connector requires **no OpticOdds API key** (credentials are runtime-injected)
  and covers **US sportsbooks only**. Live smoke tests surfaced two real defects, both fixed: (1) the
  tool's interpreter needed `requests` under `uv run` (pinned as a dep); (2) `/fixtures/odds` now
  forces `odds_format: DECIMAL` because the API defaults to American odds. **After both fixes the
  live smoke SUCCEEDED (2026-07-23):** `sync-fixtures` → 99 MLB / 17 NPB fixtures; a representative
  NPB fixture returned non-empty decimal odds for moneyline/run_line/total_runs; the MLB empty-`[]`
  odds path was live-verified (0 rows for the sampled fixtures is normal availability, not a failure,
  and does not mean MLB odds are unavailable in general). **Still NOT live-verified:** result sync,
  historical dataset build, model training, and any model performance. Any data written under
  `HANDIEDGE_DATA_DIR` is runtime/stale and **must never be committed or shipped** (the `data/` tree
  plus `*.npz`/`*.pkl`/`*.meta.json` is gitignored); **no live odds snapshot or deep link appears in
  this repo or its docs**.
- All MLB/NPB league artifacts are **UNTRAINED/NotReady**; **no accuracy/ROI/CLV is claimed** from
  the synthetic data used only in tests (always flagged `is_synthetic`).
