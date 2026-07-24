"""Deterministic fallback adapter — NON_PRODUCTION_FALLBACK.

This adapter exists ONLY to exercise the pipeline end to end in tests and local
runs. It is derived deterministically from a hash of stable input fields so that
identical inputs always yield identical outputs, with a fixed seed and no use of
system randomness. It is explicitly NOT a trained or validated model and must
never be presented as one.
"""

from __future__ import annotations

from decimal import Decimal

from app.core.clock import utc_now
from app.core.enums import ModelType
from app.core.hashing import sha256_hex
from app.domain.prediction.adapter import AdapterInfo
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.prediction import RawGamePrediction

NON_PRODUCTION_MARKER = "NON_PRODUCTION_FALLBACK"


class DeterministicFallbackAdapter:
    """Produces reproducible pseudo-predictions for integration testing only."""

    MODEL_ID = "deterministic-fallback"
    MODEL_VERSION = "0.0.0-nonprod"

    def info(self) -> AdapterInfo:
        return AdapterInfo(
            model_id=self.MODEL_ID,
            model_version=self.MODEL_VERSION,
            model_type=ModelType.DETERMINISTIC_FALLBACK,
            is_production=False,
        )

    def predict_game(
        self, game: ControlTowerGame, payload: ControlTowerPayload
    ) -> RawGamePrediction:
        # Derive a stable pseudo-probability in [0.35, 0.65] from a hash of the
        # matchup. No randomness, no system clock, fully reproducible.
        seed_material = {
            "match_id": game.match_id,
            "home": game.home,
            "away": game.away,
            "league": payload.league.value,
        }
        digest = sha256_hex(seed_material)
        bucket = int(digest[:8], 16) % 3001  # 0..3000
        home_p = Decimal("0.35") + (Decimal(bucket) / Decimal(10000))
        home_p = home_p.quantize(Decimal("0.0001"))
        away_p = (Decimal("1") - home_p).quantize(Decimal("0.0001"))

        # Expected runs anchored around a league-typical baseline, nudged by edge.
        edge = home_p - Decimal("0.5")
        home_runs = (Decimal("4.3") + edge * Decimal("4")).quantize(Decimal("0.01"))
        away_runs = (Decimal("4.3") - edge * Decimal("4")).quantize(Decimal("0.01"))

        warnings: list[str] = [f"{NON_PRODUCTION_MARKER}: output is not a trained model."]
        completeness = game.feature_summary.completeness
        if completeness is not None and completeness < 1.0:
            warnings.append(
                f"feature completeness {completeness:.2f}; missing="
                f"{','.join(game.feature_summary.missing_features) or 'unknown'}"
            )

        # Symmetric margin distribution (integer margin -> probability), used by
        # the handicap engine when available.
        margin_dist = self._margin_distribution(home_p)

        return RawGamePrediction(
            match_id=game.match_id,
            raw_home_win_probability=home_p,
            raw_away_win_probability=away_p,
            raw_team_score_expectations={"home": home_runs, "away": away_runs},
            raw_margin_distribution=margin_dist,
            feature_snapshot_id=game.feature_summary.feature_snapshot_id,
            inference_warnings=tuple(warnings),
            fallback_used=True,
        )

    @staticmethod
    def _margin_distribution(home_p: Decimal) -> dict[str, Decimal]:
        """A crude, deterministic integer-margin distribution.

        Keys are the home margin (home_score - away_score). Probabilities sum to 1.
        This is deliberately simple; a production model supplies a real one.
        """

        # Weight mass toward the favored side. Margins from -6..+6 plus tails.
        base = {
            -6: 2, -5: 3, -4: 5, -3: 8, -2: 11, -1: 14,
            1: 14, 2: 11, 3: 8, 4: 5, 5: 3, 6: 2,
        }
        skew = int((home_p - Decimal("0.5")) * Decimal("20"))  # -3..+3
        weighted: dict[int, int] = {}
        for margin, w in base.items():
            adj = w + (skew if margin > 0 else -skew)
            weighted[margin] = max(adj, 1)
        total = sum(weighted.values())
        return {
            str(m): (Decimal(w) / Decimal(total)).quantize(Decimal("0.000001"))
            for m, w in weighted.items()
        }

    @staticmethod
    def inference_timestamp():  # pragma: no cover - convenience
        return utc_now()
