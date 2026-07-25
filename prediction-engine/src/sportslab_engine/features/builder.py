"""Feature engineering — turn a consolidated slate game into a model row.

The output is a plain ``dict`` keyed by :data:`FEATURE_ORDER`, so it can be fed
to any model (XGBoost, the transparent baseline, or a pandas DataFrame for
training). Keeping this in one place guarantees training and inference build
features identically.
"""

from __future__ import annotations

from typing import Any

from ..contracts import FEATURE_ORDER

_WIND_SIGN = {"out": 1.0, "in": -1.0, "cross": 0.0, "calm": 0.0}


def wind_signed(weather: dict[str, Any] | None) -> float:
    """Signed wind: +mph blowing out (more runs), -mph blowing in."""
    if not weather:
        return 0.0
    return _WIND_SIGN.get(weather.get("windDir", "calm"), 0.0) * float(weather.get("windMph", 0))


def build_features(game: dict[str, Any]) -> dict[str, float]:
    """Assemble the ordered feature dict for one slate game."""
    data = game["data"]
    feats = game["features"]
    home_p = data.get("homePitcher") or {}
    away_p = data.get("awayPitcher") or {}
    weather = data.get("weather")

    row: dict[str, float] = {
        "home_starter_era": float(home_p.get("era", 4.5)),
        "home_starter_whip": float(home_p.get("whip", 1.3)),
        "home_starter_k9": float(home_p.get("kPer9", 8.0)),
        "away_starter_era": float(away_p.get("era", 4.5)),
        "away_starter_whip": float(away_p.get("whip", 1.3)),
        "away_starter_k9": float(away_p.get("kPer9", 8.0)),
        "home_bat_runs_pg": float(feats["home_bat_runs_pg"]),
        "away_bat_runs_pg": float(feats["away_bat_runs_pg"]),
        "home_bullpen_era": float(feats["home_bullpen_era"]),
        "away_bullpen_era": float(feats["away_bullpen_era"]),
        "home_form_l10": float(feats["home_form_l10"]),
        "away_form_l10": float(feats["away_form_l10"]),
        "park_factor": float(feats["park_factor"]),
        "temp_f": float(weather.get("tempF", 72.0)) if weather else 72.0,
        "wind_signed": wind_signed(weather),
    }
    # Fail loudly if the feature set drifts from the canonical order.
    missing = set(FEATURE_ORDER) - set(row)
    if missing:
        raise ValueError(f"feature builder missing {sorted(missing)}")
    return {k: row[k] for k in FEATURE_ORDER}


def feature_vector(game: dict[str, Any]) -> list[float]:
    row = build_features(game)
    return [row[k] for k in FEATURE_ORDER]
