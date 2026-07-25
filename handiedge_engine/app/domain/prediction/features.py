"""Deterministic feature extraction for production model adapters.

Maps a Control Tower game into a fixed, ordered numeric feature vector. Missing
features are NOT silently imputed as a hidden assumption: each missing value is
recorded as an explicit warning, and the (documented) training-time median from
the model artifact is substituted so the model can still run in a clearly-flagged
degraded mode. The Decision Engine's evidence-completeness gate then decides
whether the resulting prediction is trustworthy enough to act on.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.control_tower import ControlTowerGame

# The ordered feature contract. Adding/removing a feature is a feature-version
# change (see FEATURE_VERSION) and must be matched by the trained artifact.
FEATURE_NAMES: tuple[str, ...] = (
    "home_starter_era",
    "away_starter_era",
    "home_starter_whip",
    "away_starter_whip",
    "home_team_woba",
    "away_team_woba",
    "home_bullpen_era",
    "away_bullpen_era",
    "home_bullpen_rest_days",
    "away_bullpen_rest_days",
    "park_factor",
    "temp_f",
    "wind_mph",
    "implied_home_win_probability",
)

FEATURE_VERSION = "features-1.0.0"


@dataclass(frozen=True)
class ExtractedFeatures:
    values: tuple[float, ...]
    missing: tuple[str, ...]
    warnings: tuple[str, ...]

    @property
    def completeness(self) -> float:
        return 1.0 - (len(self.missing) / len(FEATURE_NAMES))


def _get(source: dict, *keys: str) -> float | None:
    """Fetch the first present numeric value among ``keys`` from ``source``."""

    for key in keys:
        if key in source and source[key] is not None:
            try:
                return float(source[key])
            except (TypeError, ValueError):
                return None
    return None


def extract_features(
    game: ControlTowerGame, medians: dict[str, float]
) -> ExtractedFeatures:
    """Build the ordered feature vector for ``game``.

    ``medians`` supplies the training-time fallback for any missing feature (from
    the model artifact metadata). A feature with no median available AND no value
    is substituted with 0.0 and still flagged missing.
    """

    odds = game.odds_summary or {}
    market = game.market_summary or {}
    weather = game.weather_summary or {}
    bullpen = game.bullpen_summary or {}
    starters = game.feature_summary  # feature_summary may carry engineered values
    raw_feats = getattr(starters, "model_extra", None) or {}

    def pull(name: str, *candidates: tuple[dict, tuple[str, ...]]) -> float | None:
        # explicit engineered value on feature_summary wins if present
        if name in raw_feats and raw_feats[name] is not None:
            try:
                return float(raw_feats[name])
            except (TypeError, ValueError):
                return None
        for source, keys in candidates:
            val = _get(source, *keys)
            if val is not None:
                return val
        return None

    resolved: dict[str, float | None] = {
        "home_starter_era": pull("home_starter_era", (raw_feats, ())),
        "away_starter_era": pull("away_starter_era", (raw_feats, ())),
        "home_starter_whip": pull("home_starter_whip", (raw_feats, ())),
        "away_starter_whip": pull("away_starter_whip", (raw_feats, ())),
        "home_team_woba": pull("home_team_woba", (raw_feats, ())),
        "away_team_woba": pull("away_team_woba", (raw_feats, ())),
        "home_bullpen_era": pull("home_bullpen_era", (bullpen, ("home_era",))),
        "away_bullpen_era": pull("away_bullpen_era", (bullpen, ("away_era",))),
        "home_bullpen_rest_days": pull(
            "home_bullpen_rest_days", (bullpen, ("home_rest_days",))
        ),
        "away_bullpen_rest_days": pull(
            "away_bullpen_rest_days", (bullpen, ("away_rest_days",))
        ),
        "park_factor": pull("park_factor", (weather, ("park_factor",))),
        "temp_f": pull("temp_f", (weather, ("temp_f",))),
        "wind_mph": pull("wind_mph", (weather, ("wind_mph",))),
        "implied_home_win_probability": pull(
            "implied_home_win_probability",
            (market, ("implied_home_win_probability",)),
            (odds, ("implied_home_win_probability",)),
        ),
    }

    values: list[float] = []
    missing: list[str] = []
    warnings: list[str] = []
    for name in FEATURE_NAMES:
        val = resolved[name]
        if val is None:
            missing.append(name)
            fallback = medians.get(name)
            if fallback is None:
                warnings.append(f"missing feature '{name}' and no training median; used 0.0")
                values.append(0.0)
            else:
                warnings.append(
                    f"missing feature '{name}'; substituted training median {fallback}"
                )
                values.append(float(fallback))
        else:
            values.append(val)

    return ExtractedFeatures(
        values=tuple(values), missing=tuple(missing), warnings=tuple(warnings)
    )
