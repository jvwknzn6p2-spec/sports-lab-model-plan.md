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
- **MLB / NPB**: a lock file carries `lockedAt` (first commit of the slate) and
  `updatedAt` (last re-run). A pick is frozen at its own `lockDeadline`
  (MLB: 22:59 JST the evening before; NPB: 33 minutes before first pitch), and
  later runs carry it through unchanged. The exporter therefore uses the
  **latest instant the pick could still have changed** as
  `prediction_timestamp`: the `lockDeadline` for picks made in time, and
  `updatedAt` for picks flagged `[warn] predicted_after_deadline`. This is a
  conservative upper bound — the true time is never later than the exported
  one. For late picks in legacy locks without `updatedAt` the last git commit
  touching the lock file is the next verifiable bound. Rows whose bound is not
  before `event_start_time` are excluded fail-closed and counted
  (`excluded_prediction_bound_not_before_start`) — the pick may well have
  been made before first pitch, but the record cannot show it. Rows with no
  bound at all are excluded and counted (`excluded_unverifiable_timestamp`).
  Note: the repository history was flattened on 2026-08-31 (every lock before
  that date has a single commit dated 2026-08-31), so legacy late picks from
  2026-07-28 … 2026-08-30 are excluded by this rule; the exporter's manifest
  shows the count.
- **Soccer**: `publishedAt` is exact (the ledger refuses a prediction issued
  at or after `cutoffAt` = kickoff − 60 min), so it is used as is.
- Late-but-pre-start baseball picks are **eligible** for scoring (no post-start
  data was available to them) but are marked `predicted_after_deadline=1`;
  deadline discipline itself is graded by the standing audit
  (`handiedge audit`), not by the evaluator.

### A.3 Settlement rules as implemented today (read before judging §2)
- **MLB** — `results/<date>.json` stores the MLB Stats API final score of a
  `Final` game, extra innings included. The engine settles on that score.
  A level final score (feed glitch, suspended game) settles as a **push**
  rather than being invented into a win. ✅ matches §2.
- **NPB** — `fetchNpbResults` reads the score posted on npb.jp's month
  schedule page. That is the **final posted score** (NPB plays up to the 12th
  inning; a tie after 12 is a real result and settles as a **push**). The
  regulation-9 basis required by §2 is **not what this repository's ledger
  records today**; no `regulation score` source exists in this repository
  (the sister project VORTE EV derives it from npb.jp linescores). Astra must
  treat the current NPB basis as *the documented status quo*: a PR that
  silently changes it in either direction is a §2 violation, and a PR that
  moves NPB to regulation-9 must say so explicitly, add the data source, keep
  the old evaluations untouched (append-only), and be reviewed as a
  settlement change. The exporter stamps every NPB row with
  `settlement_rule=NPB_FINAL_POSTED_SCORE_TIE_PUSH` so the basis is visible in
  the evidence.
- **Soccer** — results come from football-data.co.uk `FTHG`/`FTAG` (full time
  = 90 minutes + stoppage; extra time and penalties are not in those columns).
  A draw is a real outcome, stays in the denominator, and is scored (3-way
  RPS in the ledger; the binary export projects "home win" and keeps
  `p_draw`/`p_away`/`result_3way` columns alongside). ✅ matches §2.

### A.4 Candidate vs baseline in `predictions_eval.csv`
- Default export (no replay available): `candidate_prob` = the **calibrated**
  home-win probability that was locked; `baseline_prob` = the **raw
  (uncalibrated)** simulator probability from the same lock. This measures the
  production record and the value of the calibration layer. It does **not**
  measure the code in the PR unless the PR changes what gets locked.
- To evaluate a code change on the same games, replay the engine
  (`handiedge backtest`, or any run that writes lock-shaped files) into a
  directory and pass `--candidate-mlb-dir` / `--candidate-npb-dir` to the
  exporter: the replay becomes `candidate_prob` and the stored production lock
  becomes `baseline_prob`, joined on `gamePk`. Astra must check that the
  replay was point-in-time (no look-ahead) before trusting such a comparison.
- Soccer: `candidate_prob` = ledger `pHome` (Dixon-Coles), `baseline_prob` =
  the normalised market home probability captured at issue time
  (`market[0]`), when present.

### A.5 Sample sizes (honesty note)
The official record started 2026-07-28 (MLB), 2026-08-22 (NPB) and
2026-09-03 (soccer). Segment-level comparisons will be *descriptive only*
until the gate's minimum sample (`--min-gate-samples`, default 200) is met;
the evaluator says so in `gate.reasons`. A PASS on a descriptive-only cohort
is a PASS on evidence quality, not on model quality.
