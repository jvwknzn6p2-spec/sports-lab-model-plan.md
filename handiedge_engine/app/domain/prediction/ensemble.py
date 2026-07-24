"""Ensemble prediction adapter shell.

Combines member adapters by averaging their probabilities. Provided as a working
shell so ensemble wiring exists; production ensembles supply real weights and a
meta-model. Model disagreement is exposed as an inference warning so the Decision
Engine can gate on it.
"""

from __future__ import annotations

from decimal import Decimal

from app.core.enums import ModelType
from app.domain.prediction.adapter import AdapterInfo, PredictionAdapter
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.prediction import RawGamePrediction


class EnsemblePredictionAdapter:
    """Averages member adapters; records disagreement between members."""

    MODEL_ID = "ensemble-shell"
    MODEL_VERSION = "0.1.0"

    def __init__(self, members: list[PredictionAdapter]) -> None:
        if not members:
            raise ValueError("EnsemblePredictionAdapter requires at least one member")
        self._members = members

    def info(self) -> AdapterInfo:
        production = all(m.info().is_production for m in self._members)
        return AdapterInfo(
            model_id=self.MODEL_ID,
            model_version=self.MODEL_VERSION,
            model_type=ModelType.ENSEMBLE,
            is_production=production,
        )

    def predict_game(
        self, game: ControlTowerGame, payload: ControlTowerPayload
    ) -> RawGamePrediction:
        member_outputs = [m.predict_game(game, payload) for m in self._members]
        home_probs = [o.raw_home_win_probability for o in member_outputs]
        mean_home = (sum(home_probs) / Decimal(len(home_probs))).quantize(Decimal("0.0001"))
        mean_away = (Decimal("1") - mean_home).quantize(Decimal("0.0001"))
        disagreement = (max(home_probs) - min(home_probs)).quantize(Decimal("0.0001"))

        warnings: list[str] = []
        for o in member_outputs:
            warnings.extend(o.inference_warnings)
        warnings.append(f"model_disagreement={disagreement}")

        # Average the score expectations if present.
        score_exp: dict[str, Decimal] = {}
        for key in ("home", "away"):
            vals = [
                o.raw_team_score_expectations[key]
                for o in member_outputs
                if key in o.raw_team_score_expectations
            ]
            if vals:
                score_exp[key] = (sum(vals) / Decimal(len(vals))).quantize(Decimal("0.01"))

        fallback = any(o.fallback_used for o in member_outputs)
        return RawGamePrediction(
            match_id=game.match_id,
            raw_home_win_probability=mean_home,
            raw_away_win_probability=mean_away,
            raw_team_score_expectations=score_exp,
            raw_margin_distribution=member_outputs[0].raw_margin_distribution,
            feature_snapshot_id=game.feature_summary.feature_snapshot_id,
            inference_warnings=tuple(warnings),
            fallback_used=fallback,
        )
