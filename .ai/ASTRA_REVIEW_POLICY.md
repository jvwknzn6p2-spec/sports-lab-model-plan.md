# AI Sports Log — Astra Review Policy

Version: 1.0  
Owner: Founder  
Purpose: Gate AI-assisted changes with reproducible evidence.

## 1. Astra's role
GPT-6 Astra is the **Chief Model Auditor**, not the final decision maker.
It reviews the PR diff, automated tests, `reports/latest_evaluation.json`, and this policy.
The Founder keeps final merge authority.

Allowed final decisions:
- `PASS`
- `FIX_REQUIRED`
- `REJECT`

## 2. Non-negotiable data rules

### Prediction-time integrity
Every feature used for a prediction must have been available at or before `prediction_timestamp`.
Look-ahead bias, target leakage, post-start data, future injury/status data, or target-derived features are blocking defects.

### Settlement invariants
- MLB: final result including extra innings.
- NPB: regulation 9 innings only.
- Soccer: 90 minutes + stoppage time only; exclude extra time and penalties.

Any silent change to these semantics must not pass.

### PUSH
A PUSH is not a binary win/loss label. Exclude pushes from Brier Score and Log Loss and report them separately.

### Traceability
Preserve enough provenance to reconstruct source, `fetched_at`, `event_start_time`, `prediction_timestamp`, feature version, model version, and settlement rule.

## 3. Required evaluation
Candidate and baseline must be scored on the same eligible records.
Required metrics:
- Brier Score
- Log Loss
- Expected Calibration Error (ECE)
- Accuracy as a secondary descriptive metric
- sample size
- push count
- invalid/missing count

When a baseline exists, report paired candidate-minus-baseline deltas and a paired-bootstrap 95% confidence interval for Brier and Log Loss.
Do not approve a change solely because short-term accuracy or ROI improved.

## 4. Review checklist
Astra must inspect:
- data leakage and look-ahead bias
- train/test contamination
- duplicate events
- timestamp ordering
- missing/stale data and schema drift
- feature availability at prediction time
- train/serve skew
- temporal validation
- probability calibration
- ensemble weighting
- same-cohort baseline comparison
- Brier / Log Loss / ECE and segment regressions
- unit/integration/regression tests
- deterministic seeds where applicable
- dependency/migration risk
- secrets exposure
- rollback path

## 5. Decision policy

### PASS
Only when tests pass, evaluation data is valid, no leakage is credible, settlement rules are preserved, and no material unexplained regression exists.

### FIX_REQUIRED
Use for repairable defects, incomplete evidence/tests, or regressions needing remediation.

### REJECT
Use for confirmed leakage, fundamentally invalid evaluation, corrupted settlement semantics, or an approach requiring redesign.

## 6. Required Astra output
First line MUST be exactly one of:
- `DECISION: PASS`
- `DECISION: FIX_REQUIRED`
- `DECISION: REJECT`

Then include:

## Critical findings
## Metric assessment
## Requested changes
## Required tests
## Risks
## Evidence used

Never invent test results or metrics.

## 7. Automation limits
- maximum autonomous repair rounds: 3
- never force-push
- never delete production data
- never modify secrets
- never auto-merge `main`
- after 3 failed repair rounds, stop and escalate to the Founder

---

## Appendix A — How this repository maps onto the policy

This appendix is descriptive. It records where the evidence in §2–§3 actually
comes from in *this* repository so that Astra audits the real pipeline and not
an imagined one. It does not weaken any rule above.

### A.1 Where predictions and results live
| Sport | Predictions (locked) | Results | Settlement code |
|---|---|---|---|
| MLB | `lib/sports-data/data/predictions/<date>.json` | `lib/sports-data/data/results/<date>.json` (MLB Stats API, `Final` games only) | `lib/sports-data/src/engine/settle.ts` |
| NPB | `lib/sports-data/data-npb/predictions/<date>.json` | `lib/sports-data/data-npb/results/<date>.json` (npb.jp month schedule page) | same engine, `--league npb` |
| Soccer | `football/ledger/predictions.ndjson` | `football/ledger/results.ndjson` (football-data.co.uk) → `evaluations.ndjson` | `lib/football-model/src/ledger.ts` |

`scripts/export_evaluation.py` reads exactly these files and writes
`data/evaluation/predictions_eval.csv` plus a manifest
(`reports/evaluation_export.json`) with per-sport counts and exclusion reasons.
Nothing in the export is fabricated: a game without a stored result is
excluded and counted, never guessed.

### A.2 Prediction timestamps (what `prediction_timestamp` means here)
- **MLB / NPB**: every pick written since this policy landed carries its own
  `predictedAt` (stamped by `handiedge predict`; a pick carried through by a
  later run keeps its original stamp). That is `prediction_timestamp`, exactly.
  Legacy locks (before `predictedAt`) only carry `lockedAt` / `updatedAt` at
  the file level, so the exporter falls back to the **latest instant the pick
  could still have changed**: its `lockDeadline` (MLB 22:59 JST the evening
  before; NPB 33 minutes before first pitch — a pick made in time is frozen
  there) or, for picks flagged `[warn] predicted_after_deadline`, the lock's
  `updatedAt`. Both are upper bounds, never earlier than the truth. Rows whose
  bound is not before `event_start_time` are excluded fail-closed and counted
  (`excluded_prediction_bound_not_before_start`); late legacy picks with no
  `updatedAt` at all are excluded and counted
  (`excluded_unverifiable_timestamp`) — git history is *not* used as a bound,
  because the repository history was flattened on 2026-08-31 and commit
  metadata is not append-only. The `prediction_timestamp_basis` column names
  which rule produced each row.
- **Soccer**: `publishedAt` is exact (the ledger refuses a prediction issued
  at or after `cutoffAt` = kickoff − 60 min), so it is used as is.
- Late-but-pre-start baseball picks are **eligible** for scoring (no post-start
  data was available to them) but are marked `predicted_after_deadline=1`;
  deadline discipline itself is graded by the standing audit
  (`handiedge audit`), not by the evaluator.

### A.3 Settlement rules: versioned, and the NPB basis (judgment 1)
Rules are objects in `lib/sports-data/src/engine/settlement-rules.ts`
(`id/vN`, basis, PUSH-on-tie, status, applies-from date, edge-case notes).
Every export row carries the tag of the rule that scored it; two tags are
never mixed in one comparison.

| rule | status | basis |
|---|---|---|
| `MLB_FINAL_SCORE/v1` | production | MLB Stats API final of a `Final` game, extras included ✅ §2 |
| `NPB_FINAL_POSTED_SCORE/v1` | production before `NPB_PRODUCTION_CUTOVER` (2026-09-08); what `history.jsonl` holds for those dates | npb.jp month-page final (up to the 12th); tie = PUSH |
| `NPB_REGULATION_9/v1` | production from 2026-09-08; re-evaluation for 2026-08-22 … 2026-09-07 | score at the end of the 9th from the score page's inning line; the handicap market's basis ✅ §2 |
| `SOCCER_FULL_TIME_90/v1` | production | football-data.co.uk FTHG/FTAG (90' + stoppage) ✅ §2 |

How the NPB regulation-9 basis is realised without touching the ledger:
- **Store**: `data-npb/regulation-scores/<date>.json` — one file per slate
  date, one entry per game: end-of-9th score, innings played, source URL
  (npb.jp score page), `observedAt`, and the import provenance. Files are
  append-only: an import verifies an existing date is identical and refuses
  to rewrite it. Current source: the VORTE EV archive
  (`game_regulation_scores`, derived by its parser from npb.jp score pages
  with a self-check that games ending in ≤ 9 innings equal their final);
  joined on (date, home team name) for the dates before the cutover; from the
  cutover, `handiedge fetch-results --league npb` reads npb.jp directly
  (below).
- **Re-evaluation stream**: `handiedge reevaluate --league npb --rule
  NPB_REGULATION_9` appends to `data-npb/reevaluations.jsonl` one record per
  pick: prediction id, rule id+version, original rule, the ORIGINAL settled
  game verbatim, the re-settled game, the result data with provenance
  (`observedAt`, URL, import commit), the evaluator code version, reason,
  evidence, what changed, and an idempotency key. `history.jsonl` and
  `calibration.json` are never modified. A game without a regulation score
  is listed as *unevaluated* — never filled from the posted final.
- **No double counting**: `report`/`audit`/calibration read `history.jsonl`
  only; the re-evaluation report (`reports/reevaluation-NPB_REGULATION_9.md`)
  reads `reevaluations.jsonl` only and shows original vs re-evaluated side by
  side. Any aggregate must name which stream it read.
- **Edge cases** (rule notes; UNKNOWN items are marked as such): bottom of
  the 9th not played → final = regulation; sayonara in the 9th → counted;
  called game before the 9th → score at the call, `inningsPlayed < 9`; extra
  innings → first 9 only, a level score after 9 is a PUSH; cancelled games
  have no score under any rule. Whether every book reads called/shortened
  games exactly this way is UNKNOWN; the Founder-confirmed market rule is
  "decided at the end of the 9th".
- **Production switch** (`NPB_PRODUCTION_CUTOVER` in `settlement-rules.ts`,
  2026-09-08): from that slate date `handiedge fetch-results --league npb`
  still records the observed final score in `results/<date>.json` (kept as
  observed) but settles from the end-of-9th score, which it reads from
  npb.jp's per-game page (`npb/regulation.ts`: games index → game page →
  inning line, ≤ 9-inning self-check against 計) into
  `regulation-scores/<date>.json` with URL and `observedAt`. A game whose
  regulation score cannot be read stays pending (`regulationPending`) and is
  never settled from the posted final. Every `history.jsonl` row written
  since carries `settlementRule`; rows before the cutover keep
  `NPB_FINAL_POSTED_SCORE/v1` and are never re-scored in place. The running
  report slices the record by rule and makes no comparison across rules.
  Known limit: npb.jp's games index links only the last few days, so a
  regulation score missed in that window must be back-filled by hand or
  from the VORTE EV archive import (provenance recorded either way).

**What "win probability" means and how PUSH is scored.** `candidate_prob`
is the model's probability that the HOME team is the *decided* winner under
the row's settlement rule (the simulator produces no ties; for NPB under the
regulation rule it is therefore conditional on the 9-inning score not being
level). A PUSH row (level score under the rule) is excluded from Brier/log
loss and counted; the scored probability is thus a conditional one, and the
push rate is reported next to it, never folded into the binary metrics. The
handicap *cover* probability is a different quantity and is not exported.

### A.4 Candidate vs baseline (judgment 2)
- **Operating record (monitor)**: `candidate_prob` = the locked *calibrated*
  home-win probability, `baseline_prob` = the locked *raw* one. Measures the
  production record and the calibration layer, not the diff. In CI only its
  validity gates.
- **PR evaluation (the diff's evidence)**: `handiedge replay` recomputes
  every committed MLB lock from its committed slate with the checked-out
  code, using the lock's own calibration state and handicap lines and the
  production seeds, and seals the output (`source: "replay"`, `codeVersion`,
  slate sha256, predictions sha256, `sealedAt`, no `predictedAt`). CI runs it
  on the PR head and, in a worktree, on the base SHA against the *same* data
  files, verifies both manifests (code version = expected SHA, per-file
  hashes), exports head as candidate and base as baseline on the common
  rows, and evaluates with a date-block bootstrap. Rows missing on either
  side are excluded and counted (`excluded_no_candidate_replay`,
  `excluded_no_baseline_replay`). The exporter refuses a directory whose
  files are not replay outputs, so a stale production lock can never pose as
  a candidate.
- **As-of guarantees of a replay row**: inputs are the committed slate
  (`prediction_timestamp` = the slate's `fetchedAt`, the latest instant any
  input could have been observed; rows whose slate fetch is not before first
  pitch are excluded); calibration is the lock's state, cross-checked
  against a recomputation from history rows strictly before the date
  (`calibration_asof`; mismatches excluded); new locks stamp `inputSha256`
  so the replay can report whether the committed slate is provably the input
  a frozen pick saw (`input_snapshot_matched`).
- **What a replay does not prove**: that the production pick was made in
  time (that is `predictedAt`'s job), or that the slate itself contained
  nothing post-deadline (the slate is a snapshot taken when `fetch-slate`
  ran; a late refresh is bounded by its `fetchedAt`, not excused).
- **Not connected**: NPB (replay command works, not wired in CI) and soccer
  (no replay; its ledger predictions are immutable at issue time).
- Soccer operating record: `candidate_prob` = ledger `pHome`,
  `baseline_prob` = normalised market home probability at issue time.

### A.5 Sample sizes and what the gate's 200 means
The official record started 2026-07-28 (MLB), 2026-08-22 (NPB) and
2026-09-03 (soccer). The gate's minimum (`--min-gate-samples`, default 200)
is a *promotion limit*, not a sufficiency claim: below it a regression cannot
block on statistics (data-quality violations and leaks still do); at or above
it the block bootstrap by date (`--cluster-by event_date`) gates, and passing
it is not an automatic approval. Per-sport segments are always reported so
an all-sport total cannot hide one sport's deterioration; NPB and soccer
performance claims are not made at their current sizes. Sample-size design
from the measured paired-loss variance is in `.ai/CALIBRATION_EVAL_PLAN.md`
(`scripts/calibration_power.py`).

### A.6 Calibration layer (judgment 3)
Learning is **paused** (`calibration.json` → `frozen`, both leagues):
`settle` keeps the active parameters and writes what learning would have
produced to `calibration-shadow.json`; raw and calibrated probabilities are
recorded on every pick. The pre-registered decision plan, metrics, MDE,
looks and the verification of past as-of behaviour are in
`.ai/CALIBRATION_EVAL_PLAN.md`.
