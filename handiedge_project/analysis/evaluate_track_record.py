"""Evaluate a HandiEdge prediction track-record log against real outcomes.

Input: the `AI_Sports_Log_Master` CSV — a log of past predictions with a stated
win probability, a confidence rank, and the actual settled result. This is *not*
a per-game feature table, so it cannot train the feature-based models; what it
*can* do — and what this script does — is measure how good the predictions
actually were, using this project's own evaluation metrics.

Reuses `handiedge.evaluation.metrics` (the audited code) for log loss, Brier,
ECE, and Wilson-interval hit rate, and fits a Platt calibrator on the real
(probability → outcome) pairs with a time-ordered holdout so the reported
improvement is out-of-sample, not optimistic in-sample.

Usage:
    uv run python analysis/evaluate_track_record.py <path-to-csv> [--out out.json]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

from handiedge.evaluation.metrics import (
    brier_score,
    expected_calibration_error,
    hit_rate_with_ci,
    log_loss,
)

HIT = "的中"
MISS = "不的中"
PUSH = "プッシュ"


def _prob(raw: str) -> float | None:
    raw = (raw or "").strip().replace("%", "")
    try:
        v = float(raw)
    except ValueError:
        return None
    return v / 100.0 if v > 1 else v


def load_rows(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def gradeable(rows: list[dict]) -> list[dict]:
    """FINAL + CONFIRMED rows with a hit/miss outcome and a numeric probability."""
    out = []
    for r in rows:
        if (r.get("game_status") or "").strip() != "FINAL":
            continue
        if (r.get("verification_status") or "").strip() != "CONFIRMED":
            continue
        if (r.get("hit_status") or "").strip() not in (HIT, MISS):
            continue
        p = _prob(r.get("win_probability", ""))
        if p is None:
            continue
        r["_p"] = p
        r["_y"] = 1 if r["hit_status"].strip() == HIT else 0
        out.append(r)
    return out


def _platt_fit(p: np.ndarray, y: np.ndarray, epochs: int = 800, lr: float = 0.5) -> tuple[float, float]:
    a, b = 1.0, 0.0
    n = len(p)
    for _ in range(epochs):
        z = a * p + b
        pred = 1.0 / (1.0 + np.exp(-z))
        err = pred - y
        a -= lr * float((err * p).mean())
        b -= lr * float(err.mean())
    return a, b


def _platt_apply(p: np.ndarray, a: float, b: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-(a * p + b)))


def summarize(rows: list[dict]) -> dict:
    g = gradeable(rows)
    y = np.array([r["_y"] for r in g], dtype=float)
    p = np.array([r["_p"] for r in g], dtype=float)
    n = len(g)

    hr = hit_rate_with_ci(np.ones(n), y)  # hits vs all
    cal = expected_calibration_error(y, p, n_bins=6)

    # By confidence rank.
    by_rank: dict[str, dict] = {}
    for rank in ("S", "A", "B", "C"):
        idx = [i for i, r in enumerate(g) if (r.get("major_rank") or "").strip() == rank]
        if idx:
            yr = y[idx]
            r_hr = hit_rate_with_ci(np.ones(len(idx)), yr)
            by_rank[rank] = {
                "n": len(idx),
                "hitRate": round(r_hr.hit_rate, 4),
                "ci": [round(r_hr.ci_lower, 4), round(r_hr.ci_upper, 4)],
                "meanStatedProb": round(float(p[idx].mean()), 4),
            }

    # By league.
    by_league: dict[str, dict] = {}
    for lg in ("MLB", "NPB"):
        idx = [i for i, r in enumerate(g) if (r.get("sport") or "").strip() == lg]
        if idx:
            r_hr = hit_rate_with_ci(np.ones(len(idx)), y[idx])
            by_league[lg] = {"n": len(idx), "hitRate": round(r_hr.hit_rate, 4)}

    # Calibration fit with a time-ordered holdout (rows are chronological by date).
    order = np.argsort([r.get("date", "") for r in g], kind="stable")
    ps, ys = p[order], y[order]
    split = int(n * 0.6)
    calibrated_holdout = None
    if n - split >= 15:
        a, b = _platt_fit(ps[:split], ys[:split])
        p_hold, y_hold = ps[split:], ys[split:]
        p_cal = _platt_apply(p_hold, a, b)
        calibrated_holdout = {
            "nTrain": int(split),
            "nHoldout": int(n - split),
            "platt": {"a": round(a, 4), "b": round(b, 4)},
            "rawBrier": round(brier_score(y_hold, p_hold), 4),
            "calibratedBrier": round(brier_score(y_hold, p_cal), 4),
            "rawEce": round(expected_calibration_error(y_hold, p_hold, 5).ece, 4),
            "calibratedEce": round(expected_calibration_error(y_hold, p_cal, 5).ece, 4),
        }

    # Non-gradeable accounting (honesty: what was excluded and why).
    excluded = {
        "push": sum(1 for r in rows if (r.get("hit_status") or "").strip() == PUSH),
        "postponed_or_excluded": sum(
            1 for r in rows if "延期" in (r.get("hit_status") or "")
        ),
        "pending_or_scheduled": sum(
            1
            for r in rows
            if (r.get("game_status") or "").strip() != "FINAL"
            or (r.get("verification_status") or "").strip() != "CONFIRMED"
        ),
    }

    return {
        "source": "AI_Sports_Log_Master",
        "totalRows": len(rows),
        "gradeable": n,
        "excluded": excluded,
        "overall": {
            "hitRate": round(hr.hit_rate, 4),
            "wilsonCi": [round(hr.ci_lower, 4), round(hr.ci_upper, 4)],
            "brier": round(brier_score(y, p), 4),
            "logLoss": round(log_loss(y, p), 4),
            "ece": round(cal.ece, 4),
            "meanStatedProb": round(float(p.mean()), 4),
            "reliabilityBins": [
                {"meanPred": round(mp, 4), "observed": round(ob, 4), "n": nk}
                for (mp, ob, nk) in cal.bins
                if nk > 0
            ],
        },
        "byConfidenceRank": by_rank,
        "byLeague": by_league,
        "calibrationHoldout": calibrated_holdout,
        "caveats": [
            f"Small sample (n={n}); rank/league sub-groups are smaller still — treat as indicative, not decisive.",
            "Stated win_probability is the picked side's probability; hit_status is whether that pick covered.",
            "Push/postponed/pending rows are excluded from win/loss, not scored as losses.",
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    rows = load_rows(Path(args.csv))
    report = summarize(rows)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
