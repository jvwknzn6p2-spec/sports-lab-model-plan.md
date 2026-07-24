"""Prediction service — runs a prediction adapter over the run's games.

Enforces the invariants required of every adapter: probabilities sum to 1 within
tolerance, and outputs are deterministic. Model-specific logic stays behind the
adapter interface.
"""

from __future__ import annotations

from decimal import Decimal

from app.core.clock import utc_now
from app.core.exceptions import ValidationError
from app.domain.prediction.adapter import PredictionAdapter
from app.schemas.control_tower import ControlTowerPayload
from app.schemas.prediction import (
    PredictionModelContext,
    RawGamePrediction,
    RawPredictionBundle,
)

_PROB_TOLERANCE = Decimal("0.0001")


class PredictionService:
    def __init__(self, adapter: PredictionAdapter) -> None:
        self._adapter = adapter

    def predict(self, payload: ControlTowerPayload) -> RawPredictionBundle:
        info = self._adapter.info()
        games: list[RawGamePrediction] = []
        fallback_any = False
        for game in payload.games:
            raw = self._adapter.predict_game(game, payload)
            self._check_probabilities(raw)
            fallback_any = fallback_any or raw.fallback_used
            games.append(raw)

        context = PredictionModelContext(
            model_id=info.model_id,
            model_version=info.model_version,
            model_type=info.model_type,
            inference_timestamp=utc_now(),
            fallback_used=fallback_any,
        )
        return RawPredictionBundle(context=context, games=tuple(games))

    @staticmethod
    def _check_probabilities(raw: RawGamePrediction) -> None:
        total = raw.raw_home_win_probability + raw.raw_away_win_probability
        if (total - Decimal("1")).copy_abs() > _PROB_TOLERANCE:
            raise ValidationError(
                f"probabilities for {raw.match_id} do not sum to 1 (got {total})",
                details={"match_id": raw.match_id},
            )
        for p in (raw.raw_home_win_probability, raw.raw_away_win_probability):
            if p < 0 or p > 1:
                raise ValidationError(
                    f"probability out of range for {raw.match_id}: {p}",
                    details={"match_id": raw.match_id},
                )
