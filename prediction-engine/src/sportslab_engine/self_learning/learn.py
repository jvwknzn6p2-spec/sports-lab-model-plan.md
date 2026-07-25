"""Self-Learning Engine (Component 7) — close the loop.

Turns an error-analysis report into concrete adjustments the next run picks up:

* nudges ensemble weights based on the over/under-confidence signal — when the
  system is systematically over-confident, shift weight from the aggressive GBM
  toward the conservative transparent baseline (and vice-versa), and
* recommends recalibration when the expected calibration error is high.

The updated weights are written to the artifact the Ensemble Manager reads on the
next pipeline run, so the loop genuinely closes end-to-end. Adjustments are small
and bounded — self-learning should nudge, not lurch.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..ensemble.manager import DEFAULT_WEIGHTS, load_weights, save_weights

# Bounds so one noisy day can't swing the ensemble.
_MAX_STEP = 0.05
_MIN_GBM_WEIGHT = 0.2
_MAX_GBM_WEIGHT = 0.8
_ECE_RECALIBRATE_THRESHOLD = 0.05
_OVERCONF_DEADBAND = 0.02  # ignore tiny signals as noise
SELF_LEARNING_REPORT = "self_learning_report.json"


def _renormalize_pair(gbm_w: float, base_w: float) -> dict[str, float]:
    total = gbm_w + base_w
    return {"xgboost": gbm_w / total, "baseline": base_w / total, "lightgbm": 0.0}


def learn(report: dict[str, Any], artifacts_dir: Path) -> dict[str, Any]:
    prev = load_weights(artifacts_dir)
    gbm_w = prev.get("xgboost", DEFAULT_WEIGHTS["xgboost"])
    base_w = prev.get("baseline", DEFAULT_WEIGHTS["baseline"])

    signal = float(report.get("overconfidenceSignal", 0.0))
    ece = float(report.get("calibration", {}).get("ece", 0.0))

    rationale: list[str] = []
    if abs(signal) <= _OVERCONF_DEADBAND:
        rationale.append(f"overconfidence signal {signal:+.3f} within deadband; weights unchanged.")
        new_weights = _renormalize_pair(gbm_w, base_w)
    else:
        # Positive signal = over-confident → lean on the conservative baseline.
        step = _MAX_STEP * (1 if signal > 0 else -1)
        gbm_w = min(_MAX_GBM_WEIGHT, max(_MIN_GBM_WEIGHT, gbm_w - step))
        base_w = 1.0 - gbm_w
        direction = "toward baseline (over-confident)" if signal > 0 else "toward GBM (under-confident)"
        rationale.append(f"overconfidence signal {signal:+.3f} → shifted {abs(step):.2f} {direction}.")
        new_weights = _renormalize_pair(gbm_w, base_w)

    recalibrate = ece > _ECE_RECALIBRATE_THRESHOLD
    if recalibrate:
        rationale.append(
            f"calibration error {ece:.3f} exceeds {_ECE_RECALIBRATE_THRESHOLD}; "
            "recommend refitting the calibrator (retrain)."
        )
    else:
        rationale.append(f"calibration error {ece:.3f} acceptable.")

    save_weights(artifacts_dir, new_weights)
    result = {
        "prevWeights": prev,
        "newWeights": new_weights,
        "recalibrate": recalibrate,
        "rationale": rationale,
    }
    (artifacts_dir / SELF_LEARNING_REPORT).write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )
    return result
