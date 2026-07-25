"""Transparent statistical baseline — the explainable ensemble member.

This is the model from the original v1.0 plan (Section 4.1): a step-by-step
expected-runs formula a beginner can read and debug. Under the ML-as-source-of-
truth decision it is no longer the sole predictor, but it stays in the ensemble
so every pick keeps an explainable component and a sanity anchor for the GBM.

No training required — it is a fixed, documented formula.
"""

from __future__ import annotations

import math
from typing import Any

from ..contracts import RawModelOutput

LEAGUE_RUNS_PG = 4.5  # league-average runs scored per game (per team)
LEAGUE_ERA = 4.2
HOME_FIELD_RUNS = 0.15  # home-field edge, in runs
_WIN_PROB_SCALE = 0.65  # logistic slope on the expected run differential


def _expected_runs(
    bat_runs_pg: float,
    opp_starter_era: float,
    opp_bullpen_era: float,
    park_factor: float,
    wind_signed: float,
) -> float:
    """Expected runs for an offense, adjusted for opponent pitching, park, wind."""
    # ERA the offense faces: starter goes ~two-thirds of the game, bullpen the rest.
    opp_pitch_era = 0.65 * opp_starter_era + 0.35 * opp_bullpen_era
    # Blend the team's own scoring rate with what the opposing staff typically allows.
    base = 0.5 * bat_runs_pg + 0.5 * (LEAGUE_RUNS_PG * opp_pitch_era / LEAGUE_ERA)
    base *= park_factor  # park run environment
    base *= 1.0 + 0.01 * wind_signed  # ~1% per mph of wind blowing out/in
    return max(0.0, base)


def predict(features: dict[str, float]) -> RawModelOutput:
    home_exp = _expected_runs(
        features["home_bat_runs_pg"],
        features["away_starter_era"],
        features["away_bullpen_era"],
        features["park_factor"],
        features["wind_signed"],
    ) + HOME_FIELD_RUNS
    away_exp = _expected_runs(
        features["away_bat_runs_pg"],
        features["home_starter_era"],
        features["home_bullpen_era"],
        features["park_factor"],
        features["wind_signed"],
    )

    # Recent form nudges the run differential slightly (±, small).
    form_edge = 0.4 * (features["home_form_l10"] - features["away_form_l10"])
    diff = (home_exp - away_exp) + form_edge

    home_win_prob = 1.0 / (1.0 + math.exp(-_WIN_PROB_SCALE * diff))
    predicted_total = home_exp + away_exp
    return RawModelOutput(
        name="baseline",
        home_win_prob=float(home_win_prob),
        predicted_total=float(predicted_total),
    )


def explain(features: dict[str, Any]) -> str:
    """One-line human explanation, useful as a keyFactor."""
    out = predict(features)
    return (
        f"baseline: home {out.home_win_prob * 100:.0f}% "
        f"(total ~{out.predicted_total:.1f})"
    )
