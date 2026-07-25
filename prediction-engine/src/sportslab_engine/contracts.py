"""Typed contracts shared across the engine, plus the JSON hand-off shape.

The most important contract here is ``GamePrediction.to_review_json()``: it emits
exactly the object the TypeScript ``@workspace/ai-review`` package consumes
(camelCase keys, same nesting). That JSON file is the integration boundary
between the Python (ML) and TypeScript (orchestration/review) halves.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

# The canonical feature vector. Training, inference, and the baseline model all
# agree on this order so a saved model and a live feature row never drift.
FEATURE_ORDER: tuple[str, ...] = (
    "home_starter_era",
    "home_starter_whip",
    "home_starter_k9",
    "away_starter_era",
    "away_starter_whip",
    "away_starter_k9",
    "home_bat_runs_pg",
    "away_bat_runs_pg",
    "home_bullpen_era",
    "away_bullpen_era",
    "home_form_l10",
    "away_form_l10",
    "park_factor",
    "temp_f",
    "wind_signed",  # +mph when blowing out (more runs), -mph when blowing in
)


@dataclass(frozen=True)
class RawModelOutput:
    """One model's opinion on a game, before ensembling/calibration."""

    name: str
    home_win_prob: float
    predicted_total: float


@dataclass
class ModelOutputs:
    """Quantitative outputs for a game (mirrors the TS ModelOutputs)."""

    home_win_prob: float
    away_win_prob: float
    run_line_fav_covers: float
    run_line_dog_covers: float
    predicted_total: float
    total_line: float
    over_prob: float
    under_prob: float
    ev_bets: list[dict[str, Any]] = field(default_factory=list)
    component_agreement: float = 1.0
    market_edge: float = 0.0


@dataclass
class GamePrediction:
    """A finished prediction, ready to be emitted for AI review."""

    game_id: str
    start_time_local: str
    home_abbr: str
    home_name: str
    away_abbr: str
    away_name: str
    data: dict[str, Any]  # DataInputs shape (already camelCase)
    model: ModelOutputs
    confidence: str  # pre-review S/A/B/C
    key_factors: list[str] = field(default_factory=list)

    def to_review_json(self) -> dict[str, Any]:
        """Serialize to the exact shape TS `GamePrediction` expects."""
        m = self.model
        return {
            "gameId": self.game_id,
            "startTimeLocal": self.start_time_local,
            "home": {"abbreviation": self.home_abbr, "name": self.home_name},
            "away": {"abbreviation": self.away_abbr, "name": self.away_name},
            "data": self.data,
            "model": {
                "moneyline": {
                    "homeWinProb": round(m.home_win_prob, 4),
                    "awayWinProb": round(m.away_win_prob, 4),
                },
                "runLine": {
                    "favoriteCoversProb": round(m.run_line_fav_covers, 4),
                    "underdogCoversProb": round(m.run_line_dog_covers, 4),
                },
                "total": {
                    "predictedTotal": round(m.predicted_total, 2),
                    "line": m.total_line,
                    "overProb": round(m.over_prob, 4),
                    "underProb": round(m.under_prob, 4),
                },
                "ev": {"bets": m.ev_bets},
                "componentAgreement": round(m.component_agreement, 4),
                "marketEdge": round(m.market_edge, 4),
            },
            "confidence": self.confidence,
            "keyFactors": self.key_factors,
        }


def as_dict(obj: Any) -> dict[str, Any]:
    """Dataclass → plain dict helper (for JSON dumps of internal records)."""
    return asdict(obj)
