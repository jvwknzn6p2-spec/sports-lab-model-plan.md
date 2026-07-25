# sportslab-engine — prediction engine (Python)

The ML half of the AI Sports Lab hybrid pipeline. It owns the model/stats stages
and hands off to the TypeScript side (`@workspace/ai-review` + `@workspace/pipeline`)
for AI review, prediction lock, and settlement.

## The 7 target components → where they live

| # | Component | Where |
|---|---|---|
| 1 | **Prediction Engine** (XGBoost + transparent baseline) | Python — `engine/`, `models/`, `training/` |
| 2 | **Ensemble Manager** | Python — `ensemble/manager.py` |
| 3 | **Probability Calibration** | Python — `calibration/calibrator.py` |
| — | AI Multi-Agent Review (Step 9, already built) | TS — `@workspace/ai-review` |
| 4 | **Prediction Lock** | TS — `@workspace/pipeline` (`lock.ts`) |
| 5 | **Settlement Engine** | TS — `@workspace/pipeline` (`settlement.ts`) |
| 6 | **Error Analysis Engine** | Python — `error_analysis/analyze.py` |
| 7 | **Self-Learning Engine** | Python — `self_learning/learn.py` |

The AI review sits **between Calibration (#3) and Prediction Lock (#4)** so the
locked confidence is the reviewed (possibly downgraded) rank.

## Architecture decisions in effect

- **ML is the source of truth; the transparent baseline is an ensemble member.**
  The XGBoost GBM drives predictions; the explainable baseline formula (the old
  v1.0 model) stays in the ensemble for explainability and as a sanity anchor.
- **Hybrid stack.** Python for models/stats (uses the real `xgboost` library),
  TypeScript for orchestration + the finished review layer. The two halves talk
  through JSON files matching the `@workspace/ai-review` `GamePrediction`
  contract.
- **Fixtures now, live later.** This sandbox's egress policy blocks the external
  data APIs (`statsapi.mlb.com` etc.), so ingestion defaults to recorded
  fixtures and training runs on a recorded historical dataset. The ingestion
  client and slate assembly target the real APIs — set
  `SPORTSLAB_USE_FIXTURES=0` in an environment where those hosts are reachable.

## Run it

```bash
# one-shot end-to-end (train → predict → lock+review → settle → analyze → learn)
bash ../run_pipeline.sh 2026-07-25

# or stage by stage
export PYTHONPATH=src
python -m sportslab_engine.cli train                 # trains XGBoost + calibrator
python -m sportslab_engine.cli predict --date 2026-07-25
python -m sportslab_engine.cli analyze --settled out/settled_2026-07-25.json
python -m sportslab_engine.cli learn   --report out/error_report_2026-07-25.json

python -m pytest                                     # unit tests
python tools/make_fixtures.py                        # regenerate the training fixture
```

Install deps: `pip install -e .` (or `pip install numpy pandas scikit-learn xgboost`).
Optional: `pip install -e ".[lightgbm]"` to add LightGBM as a second GBM member.

## Data flow

```
slate fixture ─▶ features ─▶ Prediction Engine ─▶ Ensemble ─▶ Calibration
                                                                   │
                                                    predictions_<date>.json
                                                                   │  (GamePrediction contract)
                                                                   ▼
                                        TS: AI Review ─▶ Prediction Lock ─▶ locked_<date>.json
                                                                   │
                                          + results ─▶ TS: Settlement ─▶ settled_<date>.json
                                                                   ▼
                              Python: Error Analysis ─▶ error_report_<date>.json
                                                                   ▼
                              Python: Self-Learning ─▶ updated ensemble_weights.json (next run picks it up)
```

## What's real vs. deferred

- **Real:** feature engineering, XGBoost training/inference, the transparent
  baseline, ensembling, isotonic calibration, EV math, error analysis (accuracy
  by rank, ECE, Brier, ROI), and the self-learning weight-update loop. All
  unit-tested; `train` fits an actual model (validation AUC ≈ 0.62 on the
  fixture).
- **Deferred to live wiring:** the odds/weather/advanced-stats providers in the
  live slate assembler (needs those hosts/keys), and training on a real
  historical export instead of the recorded fixture.
