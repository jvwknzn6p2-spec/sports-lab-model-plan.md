# Category Checklists (1–14)

Read the section(s) relevant to the component under audit. Each item is a review question;
answering "no" or "unknown" is itself a finding — classify its severity per SKILL.md.

## 1. Sport/League/Market Taxonomy & Settlement Rules

- Is the sport/league enum closed and explicit (e.g., `CHECK (sport IN (...))`), or can arbitrary
  strings enter the system?
- Are market types (spread/handicap, moneyline, total, prop) modeled distinctly, with different
  settlement logic per type — or is one generic "result" column overloaded across market types?
- Are settlement rules for push/void/partial/cancelled events explicit and testable (not just a
  `CHECK` constraint on allowed values, but actual logic that assigns them)?
- Does the taxonomy encode league-specific quirks (e.g., NPB extra-inning tie rules, soccer
  extra-time/penalties handling, MLB rain-shortened games) or silently assume one league's rules
  apply to all?
- Is there a single canonical mapping from external data-source codes (team codes, league codes)
  to internal IDs, or ad hoc string matching per ingestion path?

## 2. Odds Ingestion, Timestamping, Source Identity, Line Movement, Stale Data

- Does every stored odds/line row have: source/bookmaker identity, an ingestion timestamp, and a
  "published_at" (or equivalent) that reflects when the line was actually live in the market —
  and are these two timestamps distinguished?
- Is there a documented policy for what counts as "stale" (e.g., no update in N minutes before
  kickoff) and does ingestion/inference code check it before use?
- Is line movement (open → intermediate → closing) preserved as an append-only time series, or
  overwritten in place (which would destroy the ability to compute CLV or as-of features)?
- Are multiple simultaneous sources reconciled explicitly (e.g., median/consensus, or a stated
  "primary source" precedence) rather than silently picking whichever arrived last?
- Is "is_closing" (or equivalent) determined by a deterministic rule tied to event start time, not
  by an operator manually flagging a row after the fact?
- Are ingestion failures (parse errors, malformed payloads, provider timeouts) logged and does
  downstream code have an explicit behavior (skip / retry / alert) rather than silently defaulting?

## 3. Vig/Overround Removal & Implied-Probability Normalization

- Is there an explicit function that converts raw odds → implied probability → vig-removed
  ("no-vig" / fair) probability? Is the removal method stated (proportional/multiplicative,
  power/Shin, or additive) and consistent across the codebase?
- Is vig removed **before** probabilities are compared to model outputs, joined into features, or
  used to compute edge/Kelly stake? Using raw (vig-included) implied probability as if it were fair
  probability is a High-severity error.
- For two-way (A/B) markets, does the normalization enforce that fair probabilities sum to 1
  exactly (not just close to 1)?
- Is the overround itself surfaced/logged as a diagnostic (large or shifting overround can signal
  a bad or manipulated line) rather than discarded silently?

## 4. Entity Resolution, Injury/Lineup/News Provenance, Time-Zone & Event-ID Integrity

- Do team/player entities have a canonical ID with a resolution table for aliases (nicknames,
  romanized-name variants, mid-season trades), or is matching done by raw string equality?
- Does every injury/lineup/news fact carry a source, a retrieval timestamp, and an "effective as
  of" time distinguishable from when it was ingested?
- Are all event timestamps stored in a single canonical timezone (UTC recommended) with the
  original local time zone preserved as metadata — or is naive local time stored, risking DST/
  cross-timezone bugs (e.g., JST games joined against UTC-based feature windows)?
- Is `event_id`/`game_id` guaranteed unique and stable across the entire pipeline (ingestion →
  features → predictions → settlement), or can duplicate/re-issued IDs corrupt joins?
- Does code reject or explicitly flag naive (timezone-unaware) datetimes at ingestion and feature
  boundaries (this is directly testable — see `test_as_of_must_be_timezone_aware` pattern)?

## 5. Feature Engineering — As-Of Joins & Leakage Prevention

- Does every feature-building function take an explicit `as_of` timestamp parameter, and does
  every SQL/dataframe join filter strictly to rows with effective time `<= as_of` (not `<`
  scheduled game time, not "most recent regardless of time")?
- Are odds-derived features (e.g., handicap movement, market consensus) computed only from lines
  published before `as_of`, never including the closing line for features used in pre-closing
  predictions?
- Are human-prediction aggregates (e.g., "% of experts picking side A") filtered to predictions
  `submitted_at < as_of`, excluding predictions submitted after that cutoff?
- Is there an automated test asserting that a feature value does not change when future rows are
  added to the source tables (i.e., a "no leakage" regression test), not just a code comment
  claiming as-of correctness?
- Are engineered features versioned/hashed (e.g., a `feature_hash`) so a served prediction's exact
  feature vector can be reconstructed and audited later?

## 6. Model Training — Temporal Splits, Baselines, Reproducibility, Calibration, Uncertainty, Abstention

- Are train/validation splits strictly time-ordered (walk-forward, expanding window, or season-
  based folds) — never `sklearn`-style random/shuffled k-fold on match-level rows? (Hard rule —
  Critical if violated.)
- Is there at least one naive baseline (e.g., always-favorite, market-implied-probability-only,
  last-season average) reported alongside the trained model, so lift over baseline is visible?
- Is training reproducible: fixed random seeds, pinned library versions, and a recorded
  hyperparameter search space/trial count (e.g., via MLflow), so a rerun produces comparable
  results?
- Is probability output calibrated (e.g., isotonic regression, Platt scaling) with the calibration
  step fit only on a holdout disjoint from the fold(s) used for point-estimate training?
- Is predictive uncertainty represented in some form (prediction interval, ensemble variance, or
  at minimum documented confidence bucketing) rather than a bare point probability?
- Is there an abstention/no-bet mechanism for low-confidence or out-of-distribution inputs (e.g.,
  insufficient historical data for a matchup), or does the system always emit a pick regardless of
  confidence?

## 7. Evaluation Beyond Hit Rate

- Are log loss and Brier score reported in addition to hit/win rate? Hit rate alone cannot detect
  miscalibration and must never be the sole reported metric.
- Is calibration error (e.g., binned reliability diagram, ECE) computed and reported?
- Is ROI reported together with a confidence interval (not a bare point estimate), and is the
  staking/odds assumption behind the ROI calculation stated explicitly?
- Is Closing Line Value (CLV) computed as entry-vs-closing implied probability (post-vig-removal
  ideally), and reported as a distinct signal from raw ROI?
- Is maximum drawdown (or an equivalent path-risk metric) reported for any bankroll simulation?
- Is sample size (`n_bets`, `n_games`) always reported next to every metric above, and are wide
  confidence intervals / small-n caveats called out rather than treated as decisive results?
- Are statistical comparisons between models (e.g., Diebold-Mariano test) corrected for multiple
  comparisons (e.g., Bonferroni) when many models/markets are compared simultaneously?

## 8. Backtesting Realism

- Does the backtest use odds that were actually available **at the moment a bet would have been
  placed** — not the closing line, not a same-day snapshot taken after the fact?
- Are bookmaker limits, minimum/maximum stake, and bet-rejection scenarios modeled (or at minimum
  explicitly assumed away and documented), rather than assuming unlimited fills at quoted odds?
- Is execution latency between "signal generated" and "bet placed" modeled or bounded, given odds
  can move in that window?
- Is slippage (odds moving between decision and execution) estimated or bounded rather than
  ignored?
- Are push/void/partial-settlement outcomes handled distinctly from win/loss in P&L calculations
  (a push must not be scored as a loss or excluded silently in a way that inflates hit rate)?
- Is the backtest walk-forward (model only ever sees past data relative to each simulated bet), matching
  the temporal-split requirement in category 6?

## 9. Prediction API Contracts & Structured Explanations

- Does the API response schema separate: point probability, confidence/uncertainty indicator,
  model version, feature hash, and a plain-language rationale — with a strict schema (e.g.,
  Pydantic) that rejects malformed output rather than passing through free text?
- Does any explanation text avoid words like "guaranteed," "sure thing," "lock," "can't lose," or
  similar? This must be checked in both model-generated and template text. (Hard rule — Critical
  if violated.)
- Is the model version and feature hash included in every prediction response so it is
  reproducible and auditable after the fact?
- Does the API define and document behavior for the abstention case (category 6) — e.g., a
  specific status/field rather than a fabricated low-confidence pick?
- Are error responses (missing data, stale odds, no active line) explicit and typed, rather than
  silently returning degraded output?

## 10. Bankroll & Risk Controls

- Is there an explicit max-exposure-per-bet and max-exposure-per-day/period control, enforced in
  code (not just documented) before a stake is finalized?
- Is correlated-bet exposure addressed (e.g., multiple bets on the same game/team/market that would
  jointly amplify a single outcome), or is each bet sized independently with no portfolio view?
- Are stop-loss / stop conditions (e.g., halt staking after N consecutive losses or a drawdown
  threshold) implemented, and are they distinct from any stake-sizing formula?
- Is stake sizing (e.g., Kelly fraction) capped (e.g., fractional Kelly) rather than full Kelly,
  given model-probability uncertainty?
- Is there any logic that increases stake size specifically to recoup prior losses (chase-loss /
  martingale pattern)? This must not exist anywhere in the codebase. (Hard rule — Critical if
  found.)

## 11. Security, Privacy, Secrets, Authorization, Audit Chain, Observability

- Are secrets (API keys, DB passwords, signing pepper) sourced only from environment variables/
  secret managers, never hardcoded or committed, and never printed in logs?
- Is authorization enforced via row-level security or equivalent for any user/predictor-scoped
  data, verified by an explicit test (not just a policy definition)?
- Is JWT/OIDC validation actually verifying signature, audience, issuer, and expiry — not just
  decoding the payload?
- Does the audit log use an append-only, hash-chained design (prev_hash → self_hash) with the
  generation algorithm and the verification algorithm provably identical (same concatenation
  order, same pepper source)? Any mismatch between generation and verification logic is a Critical
  finding.
- Are internal metrics/observability endpoints (e.g., `/internal/metrics`) authenticated and
  network-restricted, not open on a public route?
- Is personally-identifying information (real names, precise location, payment details) excluded
  from logs, model features, and any data sent to third-party AI providers? Is there a masking/
  classification layer with a test proving sensitive fields never reach external providers?

## 12. Deployment, Drift Monitoring, Retraining Gates, Rollback, Incident Response

- Is there a defined process for detecting feature/label/prediction drift in production (e.g.,
  population stability index, rolling calibration checks), not just a one-time offline evaluation?
- Are retraining gates explicit (e.g., "do not promote a new model unless it beats the current
  production model on log loss AND does not regress ROI CI on holdout") rather than promoting on
  a single metric or on a schedule alone?
- Is there a documented, testable rollback path to the previous model version (e.g., a model
  registry with version pinning and a hot-swap/reload mechanism)?
- Is there an incident-response procedure for a detected error (e.g., wrong settlement, leaked
  data, mis-priced stake) — who is notified, what is paused, how is it remediated?
- Are health checks for all runtime dependencies (DB, inference server, model registry) implemented
  and wired into deployment gating, not left as TODOs?

## 13. Tests & Acceptance Gates

- Does every Critical/High-severity fix have a corresponding automated test that would fail
  without the fix and pass with it?
- Is there a leakage regression test (category 5) and a masking/no-leak test (category 11) present
  and required to pass before deployment, as opposed to optional/manual checks?
- Are acceptance gate commands (lint, type-check, unit tests, migration, integration smoke test)
  explicitly listed and required to all pass before any "done"/"production-ready" claim, per the
  hard rules in SKILL.md?
- Are test results from this session actually pasted/shown, or merely asserted as passing?

## 14. Responsible Gambling, Age/Jurisdiction Controls, Non-Guarantee Language

- Does every user-facing prediction surface (API response, UI, report) carry explicit non-
  guarantee language (e.g., "estimated probability, not a guarantee of outcome")?
- Is there an age-verification and jurisdiction-eligibility gate documented as required before any
  staking-related feature ships, even if not yet implemented (flag as a required-but-missing
  control rather than silently omitting it)?
- Is there a mechanism (or at least a documented requirement) for self-exclusion / responsible-
  gambling messaging appropriate to the product's jurisdiction(s)?
- Does marketing/UI copy avoid implying skill-based certainty or "beat the house" framing that
  could constitute a guaranteed-win claim?
