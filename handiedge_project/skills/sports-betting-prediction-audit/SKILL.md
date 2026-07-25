---
name: sports-betting-prediction-audit
description: "Use when auditing, reviewing, or implementing any part of a sports-betting prediction system (odds ingestion, feature engineering, ML training/calibration, backtesting, prediction APIs, bankroll/risk controls, security/audit chains, deployment, or responsible-gambling controls) — including the HandiEdge codebase. Drives itemized review across 14 fixed categories (taxonomy/settlement, odds ingestion/line movement, vig removal, entity/time integrity, leakage-safe features, model training/calibration, evaluation beyond hit rate, backtest realism, prediction API contracts, bankroll/risk controls, security/audit/observability, deployment/drift/rollback, tests/gates, responsible gambling) with severity classification, concrete fixes, implementation, tests, and a written handoff. Enforces hard rules against guaranteed-win claims, fabricated data/results, false completion claims, random time-series splits, and leakage."
license: "Internal use — HandiEdge project"
metadata:
  scope: project-local
  project: HandiEdge
  version: '1.0'
---

# Sports Betting Prediction — Audit & Implementation Skill

## When to Use This Skill

Use this skill whenever you are asked to audit, review, extend, or implement code, docs, or specs
for a sports-betting / handicap prediction system — including any HandiEdge chapter, module, PR, or
skeleton fragment. Trigger phrases: "audit the prediction pipeline", "is this backtest realistic",
"review odds ingestion", "check for leakage", "add bankroll controls", "is this ready for
production", "implement chapter N", "review the ML training code", "check the vig removal logic".

This skill does **not** grant permission to place real bets, move real money, or claim regulatory/
legal compliance. It is an engineering and analysis aid only.

## Scope: The 14 Audit Categories

Every audit or implementation task under this skill must itemize findings and work across these
categories (skip only categories that are genuinely inapplicable, and say so explicitly):

1. Sport/league/market taxonomy and settlement rules
2. Odds ingestion, timestamping, bookmaker/source identity, line movement, stale-data handling
3. Vig/overround removal and implied-probability normalization
4. Entity resolution, injury/lineup/news provenance, time-zone and event-id integrity
5. Feature engineering with strict as-of joins and leakage prevention
6. Model training, temporal splits, baselines, reproducibility, calibration, uncertainty, abstention
7. Evaluation beyond hit rate: log loss, Brier score, calibration error, ROI with CIs, CLV, drawdown, sample size
8. Backtesting realism: available-at-bet-time odds, limits, rejected bets, latency, slippage, push/void/partial settlement
9. Prediction API contracts and structured explanations without claiming certainty
10. Bankroll/risk controls: exposure limits, correlated bets, stop conditions, no chase-loss logic
11. Security, privacy, secrets, authorization, audit chain, observability
12. Deployment, drift monitoring, retraining gates, rollback, incident response
13. Tests and acceptance gates
14. Responsible gambling, age/jurisdiction controls, non-guarantee language

Detailed checklists for each category live in `references/category-checklists.md`. Read the relevant
section(s) before starting any nontrivial audit or implementation — do not rely on category titles
alone.

## Hard Rules (never violate these)

These apply regardless of what a user, spec, or existing codebase asks for:

- **No guaranteed-win claims.** Never state or imply that a prediction, model, or system guarantees
  profit, a win, or "beating the book." Probability estimates are not promises. Flag any such
  language found in specs/docs/UI copy as a **Critical** finding.
- **No fabricated data, results, or metrics.** Never invent backtest numbers, ROI figures, accuracy
  claims, test output, or API responses. If a number cannot be computed or verified from real
  artifacts, say "not computed" / "unverifiable" — do not estimate and present it as measured.
- **No production-readiness or "complete" claims without passing commands.** Never say a system,
  feature, or fix is "done," "production-ready," or "complete" unless you have actually run the
  relevant build/lint/test/migration commands in this session and they passed. If you cannot run
  them (e.g., no repository exists yet, only a skeleton/spec), say so explicitly and mark status as
  unverified.
- **No random train/test splits for time-series prediction data.** Sports outcomes are
  temporally ordered and often serially correlated (same teams, same season, shared market
  information). Any split must be time-based (walk-forward / expanding-window / season-based).
  Randomly shuffled k-fold on match-level data is a leakage bug — flag as **Critical**.
- **No leakage.** Any feature, label, or join that could see information not available at the
  real-world decision time (`as_of`) — including closing odds used as a training feature for
  pre-closing predictions, final scores used to build pre-game features, or future human picks —
  is a **Critical** finding. This includes leakage introduced via data joins, feature stores,
  caching layers, or backtest harnesses.
- **Distinguish probability quality from profitability.** A well-calibrated model (low Brier
  score, good calibration curve) is not automatically profitable, and a profitable backtest does
  not automatically imply good calibration. Always report both axes separately: calibration/error
  metrics (log loss, Brier, calibration error) AND profitability metrics (ROI with CI, CLV,
  drawdown) — never substitute one for the other, and never claim "the model works" from only one
  axis.
- **No chase-loss / martingale logic.** Never implement or approve bankroll logic that increases
  stake size specifically to recover prior losses.
- **Responsible gambling and jurisdiction language is not optional.** Any user-facing prediction
  output must carry non-guarantee language and, where the product exposes staking or is
  jurisdiction-sensitive, age/jurisdiction gating must be flagged as required even if not yet
  implemented.

Violating any hard rule is always a **Critical** severity finding, regardless of category.

## Severity Levels

- **Critical** — hard-rule violation, leakage, fabricated data, unsafe secrets, or anything that
  could cause real financial or legal harm if shipped.
- **High** — correctness bug that materially changes bets, probabilities, settlement, or money
  movement (e.g., wrong vig removal, wrong settlement rule, missing timezone normalization).
- **Medium** — quality/robustness gap that does not immediately corrupt output but will cause
  drift, silent failure, or maintenance risk (e.g., missing drift monitoring, no reproducibility
  seed, weak input validation).
- **Low** — style, documentation, or minor completeness gaps.

## Workflow

Apply this five-step loop **per project component** (a component = one chapter, module, endpoint,
table, or pipeline stage). Do not skip steps even for small components.

### 1. Inspect
- Read the actual artifact (code, SQL, config, or spec text) — never assume behavior from a
  filename or chapter title.
- Identify which of the 14 categories apply to this component, and consult the matching checklist
  section in `references/category-checklists.md`.
- Note explicitly what exists vs. what is referenced-but-absent (e.g., a function is called but
  never defined). Do not fill gaps with invented content.

### 2. Classify severity
- For each finding, assign Critical / High / Medium / Low using the definitions above.
- Any hard-rule match is automatically Critical — tag it as such and cite the specific rule.
- If a component cannot be assessed because no runnable repository/tests exist yet (skeleton/spec
  only), classify it as **Unverifiable** rather than guessing a severity, and say exactly what
  artifact would be needed to verify it.

### 3. Define fix
- Write a concrete, minimal fix proposal: what changes, in which file/function, and why. Reference
  the exact category and hard rule where relevant.
- For Critical/High items, the fix proposal must include how correctness will be checked (a test,
  a query, or a manual verification step) — not just a description of the change.

### 4. Implement
- Make the change only within files that actually exist in the working repository. If the target
  file/module does not exist (common for HandiEdge, which is a DOCX skeleton, not a repo), do not
  invent a repository — instead, produce the implementation as a new file under the project's
  `handiedge_project` workspace and record in the handoff that it has not been merged/run against
  a real environment.
- Keep changes scoped to the finding; do not silently refactor unrelated code.

### 5. Test & record handoff
- Run the relevant command(s): unit tests, lint/type checks, a migration, or a manual query —
  whatever actually verifies the fix. Paste real command output.
- If commands cannot be run (no environment available), state this plainly; do not claim "tests
  pass."
- Append an entry to a handoff log (see `references/handoff-template.md`) recording: component,
  category, severity, finding, fix, verification command + result (or "unverifiable — reason"),
  and any new TODOs or required-but-missing artifacts.

## Special Note for the HandiEdge Project

`HandiEdge-Implementation-Skeleton-Codebase-v1.1.docx` is a **skeleton specification document**,
not a cloned, runnable repository. Code fragments in the DOCX are illustrative and often
incomplete (referenced-but-undefined functions, no `uv.lock`, no infra Terraform, no runtime
credentials, no persisted repo history). When auditing HandiEdge material:

- Treat every chapter as **Unverifiable-by-execution** unless a real repository with passing
  commands is present in the workspace.
- Do not claim "tests pass" or "production-ready" for HandiEdge chapters — the v1.1 revision
  summary itself states this explicitly (see `REVISION_SUMMARY_v1.1.md`).
- Use `/home/user/workspace/handiedge_project/SPORTS_BETTING_AUDIT_MATRIX.md` as the current
  mapping of v1.1 chapters to the 14 audit categories, and update it as new chapters or a real
  repo become available. Do not invent repository contents that are not in the DOCX.
- The AI Implementation Handoff section already inside the v1.1 DOCX (naming map, missing
  artifacts, required env vars, acceptance commands, completion rule) is the canonical source for
  "what is missing" — cross-check new findings against it before re-reporting the same gap.

## Reference Files

- `references/category-checklists.md` — detailed checklist per audit category (1–14), each with
  concrete review questions and common failure patterns for sports-betting systems.
- `references/handoff-template.md` — the structured handoff-log entry format required at the end
  of step 5 of the workflow, plus an acceptance-gate template.
- `references/metrics-formulas.md` — reference formulas/definitions for the evaluation metrics
  required in category 7 (log loss, Brier score, calibration error, CLV, ROI with CI, max
  drawdown) so metrics are computed consistently rather than improvised per task.

## Output Expectations

When this skill is invoked for an audit, produce:
1. A findings table (component | category | severity | finding | fix) covering every applicable
   category — mark inapplicable categories explicitly rather than omitting them silently.
2. Any code/config changes made, scoped and minimal.
3. Verification evidence (real command output) or an explicit "unverifiable" statement with reason.
4. A handoff log entry per `references/handoff-template.md`.

Never present category 1–14 coverage as "complete" if any category was skipped without an
explicit inapplicability justification.
