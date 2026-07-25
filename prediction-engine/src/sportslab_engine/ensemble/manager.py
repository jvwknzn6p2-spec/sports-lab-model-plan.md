"""Ensemble Manager (Component 2).

Combines the opinions of several models — the XGBoost GBM, the transparent
baseline, and optionally LightGBM — into one consensus probability and total.
It also computes a *component agreement* score (how tightly the members agree),
which flows straight into the Risk Reviewer: low agreement means a fragile pick.

Weights are read from an artifact file when present so the Self-Learning engine
can tune them over time; otherwise sensible defaults apply.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..contracts import RawModelOutput

DEFAULT_WEIGHTS: dict[str, float] = {"xgboost": 0.6, "baseline": 0.4, "lightgbm": 0.0}
WEIGHTS_FILE = "ensemble_weights.json"


@dataclass
class EnsembleResult:
    home_win_prob: float
    predicted_total: float
    component_agreement: float
    members: list[RawModelOutput]


def load_weights(artifacts_dir: Path) -> dict[str, float]:
    path = artifacts_dir / WEIGHTS_FILE
    if path.exists():
        stored = json.loads(path.read_text(encoding="utf-8"))
        return {**DEFAULT_WEIGHTS, **{k: float(v) for k, v in stored.items()}}
    return dict(DEFAULT_WEIGHTS)


def save_weights(artifacts_dir: Path, weights: dict[str, float]) -> None:
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    (artifacts_dir / WEIGHTS_FILE).write_text(json.dumps(weights, indent=2), encoding="utf-8")


def _agreement(probs: list[float]) -> float:
    """1.0 when all members agree, →0 as they spread out."""
    if len(probs) <= 1:
        return 1.0
    mean = sum(probs) / len(probs)
    var = sum((p - mean) ** 2 for p in probs) / len(probs)
    std = var**0.5
    # 0.25 is roughly the max meaningful std for probabilities that cluster near
    # a decision; scale to [0, 1] and invert.
    return max(0.0, min(1.0, 1.0 - std / 0.25))


def combine(members: list[RawModelOutput], weights: dict[str, float]) -> EnsembleResult:
    if not members:
        raise ValueError("ensemble needs at least one member")

    active = [(m, weights.get(m.name, 0.0)) for m in members]
    total_w = sum(w for _, w in active)
    if total_w <= 0:
        # Degenerate weights — fall back to an equal-weight mean.
        active = [(m, 1.0) for m in members]
        total_w = float(len(members))

    home_win_prob = sum(m.home_win_prob * w for m, w in active) / total_w
    predicted_total = sum(m.predicted_total * w for m, w in active) / total_w
    agreement = _agreement([m.home_win_prob for m in members])
    return EnsembleResult(
        home_win_prob=home_win_prob,
        predicted_total=predicted_total,
        component_agreement=agreement,
        members=members,
    )
