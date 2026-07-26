# HandiEdge — Real Track-Record Evaluation

Measured from `AI_Sports_Log_Master` (your logged predictions) using this
project's own metric functions (`handiedge.evaluation.metrics`). **VERIFIED** —
run with real data, real outcomes.

```bash
cd handiedge_project
uv run python analysis/evaluate_track_record.py <AI_Sports_Log_Master.csv>
```

## What this data is (and isn't)

It's a **prediction log**: 162 rows of past picks with a stated win probability,
a confidence rank, and the settled result. It is **not** a per-game feature table
(no pitcher/lineup/park features), so it cannot train the feature-based league
models — but it can honestly answer *"how good have the predictions actually
been?"* and calibrate the stated probabilities.

- **162 total** → **149 gradeable** (FINAL + CONFIRMED, hit/miss outcome).
- Excluded: 3 push, 4 postponed/excluded, 10 pending/scheduled — **not** scored as losses.

## Headline results

| Metric | Value |
|---|---|
| Hit rate | **51.0%** (Wilson 95% CI **43.1%–58.9%**) |
| Mean stated probability | **57.7%** |
| **Over-confidence gap** | **+6.7 pts** (says ~58%, hits ~51%) |
| Brier | 0.254 |
| Log loss | 0.702 |
| ECE | 0.067 |

**Honest read:** handicap picks are landing near coin-flip (~51%) — normal for
handicap markets — and the stated probabilities are **systematically
over-confident by ~7 points.** Hit rate alone would hide this; the calibration
metrics surface it.

## By confidence rank

| Rank | n | Hit rate | 95% CI | Mean stated |
|---|---|---|---|---|
| S | 5 | 60.0% | 23–88% | 65.6% |
| A | 39 | 51.3% | 36–66% | 61.3% |
| B | 81 | 50.6% | 40–61% | 56.9% |
| C | 24 | 50.0% | 31–69% | 53.1% |

There's a **weak** monotonic hint (S ≥ A ≥ B ≥ C) but the sub-samples are tiny
and the confidence intervals overlap almost entirely — **not statistically
significant**. The ranks are not yet demonstrably separating winners from
coin-flips.

## By league

| League | n | Hit rate |
|---|---|---|
| MLB | 107 | 51.4% |
| NPB | 42 | 50.0% |

## Calibration — fit on real outcomes

A Platt calibrator fit on a **time-ordered holdout** (train 89 / test 60)
improved the *out-of-sample* numbers:

| | Raw | Calibrated |
|---|---|---|
| ECE (holdout) | 0.105 | **0.071** |
| Brier (holdout) | 0.260 | **0.254** |

Fit on all 149 rows (`analysis/track_record_calibrator.json`, `a=0.871, b=-0.462`),
it pulls the over-confident probabilities toward reality:

- stated **66% → 53%**
- stated **55% → 50%**

## What this means for the project

1. **The stated probabilities need calibration before they're trustworthy.** The
   fitted calibrator here is a ready artifact to apply to future picks.
2. **The confidence ranks aren't proven yet** — with more logged games, re-run
   this to see whether S/A genuinely separate from B/C.
3. **This does not replace training the feature models.** To move the league
   models from UNTRAINED → TRAINED you still need a per-game feature dataset
   (pitchers, bullpen, park, odds), not a prediction log. This log is the
   *evaluation/calibration* input, not the *training* input.

## Caveats

- Small sample (n=149); rank/league subgroups smaller still — indicative, not decisive.
- Stated probability is the picked side's; hit_status is whether that pick covered.
- Raw log is not committed (personal betting data); only these aggregate results are.

Machine-readable: [`track_record_report.json`](./track_record_report.json) ·
calibrator: [`track_record_calibrator.json`](./track_record_calibrator.json).
