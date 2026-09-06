# Calibration layer — pre-registered evaluation plan (judgment 3)

Status: **learning paused** since 2026-09-06 (`calibration.json` → `frozen`,
both leagues). The active shrink parameters are fixed at the values below;
every `settle` still computes what learning would have produced and writes it
to `calibration-shadow.json` (never applied). Raw (`rawHomeWinProbability`)
and calibrated (`homeWinProbability`) probabilities are recorded on every
pick, so the two can be compared on the same games without either having
steered a pick.

Frozen parameters (MLB `data/calibration.json`, 2026-09-02 state):
shrink 0.905 / tail 0.697 / far-tail 0.647; handicap 0.826 / 0.626 / 0.626;
total 0.834 / 0.859 / 0.833. NPB: its own file, frozen the same way.

## Why paused rather than kept or removed

On the operating record to 2026-09-02 (258 scored rows: MLB 210, NPB 43,
soccer 5; soccer has no calibration layer and is excluded from the decision):

| metric | calibrated | raw | Δ (cal − raw) | paired bootstrap 95% CI | block (by date) 95% CI |
|---|---|---|---|---|---|
| Brier | 0.2381 | 0.2377 | +0.0004 | [−0.0009, +0.0018] | [−0.0003, +0.0012] |
| log loss | 0.6688 | 0.6682 | +0.0006 | [−0.0027, +0.0036] | (reported in CI artifact) |
| ECE (10 bins) | 0.065 | 0.073 | −0.008 | — | — |

The point estimates are slightly worse on the proper scores and better on
ECE; every interval contains 0. Neither "helps", "hurts" nor "equivalent" can
be concluded, so the layer is neither promoted nor removed — it is frozen and
measured.

## Pre-specified design

- **Primary metric**: mean Brier (calibrated − raw), paired per game.
- **Guard metric**: mean log loss (calibrated − raw). A primary improvement
  with a guard deterioration is not a pass.
- **Diagnostics** (never decisive): ECE with 10 fixed equal-width bins on the
  stated probability, per-bin n and Wilson 95% interval; reliability curve;
  logistic recalibration slope/intercept (`diagnostics` in the evaluator).
- **Cohort**: MLB games with a stored final, a verifiable prediction time
  and calibration state (`calibration_asof = verified`), PUSH excluded and
  counted. NPB is reported separately and does not enter the decision until
  it has ≥ 200 scored rows under the regulation-9 rule.
- **Minimum improvement worth acting on (MDE)**: 0.002 in mean Brier.
- **Non-inferiority margin for keeping the frozen layer**: calibrated − raw
  Brier ≤ +0.002 with the block-bootstrap 95% CI upper bound ≤ +0.003.
- **Confidence / power**: two-sided α = 0.05, power 0.80.
- **Bootstrap**: paired, resampling *dates* as blocks (`--cluster-by
  event_date`), 2000 draws, seed 42; row-wise CI reported alongside.
- **Evaluation windows**: the decision uses only rows with `event_date` on or
  after 2026-09-07 (prospective; no row seen while writing this plan).
  Training of the frozen parameters ended 2026-09-02. The window 2026-09-03 …
  2026-09-06 is a buffer and is excluded from the decision.
- **Re-judgment rule**: one interim look when the prospective cohort reaches
  the row count below; a final look at 2× that count or 2026-11-30, whichever
  first. No other looks count. Two consecutive windows (e.g. September and
  October) must agree in sign before a promotion or removal is proposed.

## Sample size from the measured variance (not from the summary)

`scripts/calibration_power.py` on the 2026-09-06 record (paired per-row
differences, days as clusters; `reports/calibration_power.json` in the CI
artifact):

| metric | var(Δ) | sd(Δ) | lag-1 autocorr. of daily means | ICC by day | design effect | rows for Δ=0.002 (indep.) | rows for Δ=0.002 (with day design effect) |
|---|---|---|---|---|---|---|---|
| Brier | 1.36e-4 | 0.0117 | 0.000 | 0.044 | 1.63 | 267 | 434 |
| log loss | 6.79e-4 | 0.0261 | −0.007 | 0.056 | 1.80 | 1332 | 2393 |

So the interim look for the primary metric is at **434 prospective MLB rows**
(≈ 29 slate days at the current ~15 games/day), the final at 868 rows or
2026-11-30. The guard metric will not reach power at that size; it is used
only to veto, not to confirm. These numbers are re-derived from the data at
each look (the variance is an estimate, not a constant).

## Decision rules (fixed now)

- **Keep frozen calibration** if, on the prospective cohort at a scheduled
  look, the block-bootstrap 95% CI of (calibrated − raw) Brier lies entirely
  below +0.002 and the guard metric's CI does not lie entirely above 0.
- **Propose switching production to raw** (a separate, explicit PR) if the
  CI lies entirely above 0 on the primary metric, or if a time-series leak
  in how calibration was locked is found (`calibrationAsOf` mismatch that
  cannot be explained by a code change).
- **Propose a redesign** only after both looks and only after the
  reliability-curve shape has been inspected (per band, with intervals).
- Anything else: stay frozen and wait for the next scheduled look.

## What was verified about the past (2026-09-06)

- The lock's calibration equals the state rebuilt from history rows strictly
  before the date for every MLB lock from 2026-08-17 to 2026-09-02
  (`calibrationAsOf.verified = true`, 16 dates); for locks before 2026-08-17
  it does not, which is attributable to the 2026-08-21 change of the
  learning code (three-band tails) and cannot be separated from a leak by
  the record alone, so those rows are **excluded** from performance evidence
  (`excluded_calibration_not_asof`).
- The replay reproduces the production probabilities exactly for
  2026-08-17 … 2026-08-26 (all 145 picks); from 2026-08-27 only partly,
  because the refresh run re-fetches the slate after some picks are frozen
  and the committed slate is then not the input those picks saw. New locks
  stamp `inputSha256` per pick so this is measurable going forward.
