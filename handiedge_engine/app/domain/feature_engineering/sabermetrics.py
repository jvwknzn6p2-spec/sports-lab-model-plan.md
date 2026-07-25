"""Sabermetric rate stats — the single source of truth for wOBA / ERA / WHIP.

These pure functions turn raw counting stats into the rate stats the model's
feature vector needs. They are used by BOTH the leakage-safe historical dataset
builder (``app.domain.prediction.dataset``) and the live daily feature-
engineering path (``app.services.daily_slate_service``), so the numbers a model
is trained on and scored on are computed identically — never two drifting copies.

The wOBA linear weights are a FanGraphs-style modern-era approximation; season-
specific "Guts!" constants can be substituted later without changing callers.
"""

from __future__ import annotations

# Standard wOBA linear weights (FanGraphs-style, modern-era approximation).
WOBA_WEIGHTS: dict[str, float] = {
    "bb": 0.69,
    "hbp": 0.72,
    "1b": 0.89,
    "2b": 1.27,
    "3b": 1.62,
    "hr": 2.10,
}


def earned_run_average(earned_runs: float, innings: float) -> float | None:
    """Classic ERA: earned runs per nine innings. ``None`` if no innings."""

    if innings <= 0:
        return None
    return 9.0 * earned_runs / innings


def whip(walks: float, hits: float, innings: float) -> float | None:
    """Walks + hits per inning pitched. ``None`` if no innings."""

    if innings <= 0:
        return None
    return (walks + hits) / innings


def woba(
    *,
    at_bats: float,
    walks: float,
    intentional_walks: float,
    hit_by_pitch: float,
    singles: float,
    doubles: float,
    triples: float,
    home_runs: float,
    sac_flies: float,
) -> float | None:
    """Weighted On-Base Average from batting components.

    Returns ``None`` when the plate-appearance denominator is non-positive
    (insufficient data) rather than a fabricated number.
    """

    denominator = at_bats + walks - intentional_walks + sac_flies + hit_by_pitch
    if denominator <= 0:
        return None
    numerator = (
        WOBA_WEIGHTS["bb"] * (walks - intentional_walks)
        + WOBA_WEIGHTS["hbp"] * hit_by_pitch
        + WOBA_WEIGHTS["1b"] * singles
        + WOBA_WEIGHTS["2b"] * doubles
        + WOBA_WEIGHTS["3b"] * triples
        + WOBA_WEIGHTS["hr"] * home_runs
    )
    return numerator / denominator
