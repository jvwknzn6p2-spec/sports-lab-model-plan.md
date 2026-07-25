"""Prediction orchestration (categories 3, 5, 6, 9, 10, 14).

Pipeline for one event:
1. build as-of features (leakage-safe);
2. get the model's calibrated probability for side A;
3. remove vig from the market line to get the fair market probability;
4. compute edge = model_prob - fair_market_prob (never vs raw implied);
5. apply the abstention policy; if betting, size with fractional Kelly + caps;
6. emit a strict, non-guarantee response with model/data timestamps.

The model is injected (any object with ``predict_proba``) plus an optional
calibrator, so this runs fully offline with the NumPy baselines and does not
depend on the unavailable ML registry/inference server.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol

import numpy as np

from ..domain.events import Event, require_aware
from ..domain.taxonomy import MarketType
from ..errors import StaleDataError
from ..features.builder import FeatureBuilder
from ..modeling.abstention import AbstainReason, AbstentionPolicy
from ..odds.ingestion import OddsIngestor
from ..probability.implied import remove_vig
from ..responsible.gambling import NON_GUARANTEE_DISCLAIMER
from ..risk.bankroll import kelly_fraction
from .contracts import Decision, PredictionResponse


class Calibrator(Protocol):  # structural type
    def transform(self, raw: np.ndarray) -> np.ndarray: ...


class PredictionService:
    def __init__(
        self,
        *,
        ingestor: OddsIngestor,
        feature_builder: FeatureBuilder,
        model: object,
        model_version: str,
        calibrator: object | None = None,
        abstention: AbstentionPolicy | None = None,
        vig_method: str = "multiplicative",
        kelly_multiplier: float = 0.25,
    ) -> None:
        self._ingestor = ingestor
        self._fb = feature_builder
        self._model = model
        self._version = model_version
        self._cal = calibrator
        self._abstain = abstention or AbstentionPolicy()
        self._vig_method = vig_method
        self._kelly_mult = kelly_multiplier

    def predict(self, event: Event, as_of: datetime | None = None) -> PredictionResponse:
        now = datetime.now(UTC)
        as_of = require_aware(as_of or now, "as_of")

        fv = self._fb.build(event, as_of)

        raw = float(self._model.predict_proba(np.array([fv.to_array()]))[0])  # type: ignore[attr-defined]
        prob_a = float(self._cal.transform(np.array([raw]))[0]) if self._cal else raw  # type: ignore[attr-defined]
        prob_a = float(np.clip(prob_a, 1e-6, 1 - 1e-6))

        # Market fair probability (vig removed) — the honest edge reference.
        fair_market_a: float | None = None
        try:
            quote = self._ingestor.quote_for_decision(event.event_id, MarketType.HANDICAP, as_of)
            fair = remove_vig([quote.odds_a, quote.odds_b], method=self._vig_method)
            fair_market_a = fair.probabilities[0]
        except StaleDataError:
            return self._abstain_response(event, fv, as_of, now, AbstainReason.STALE_ODDS)

        edge = prob_a - fair_market_a
        pick_side = "A" if prob_a >= fair_market_a else "B"
        # Edge on the picked side (magnitude).
        signed_edge = edge if pick_side == "A" else -edge

        reason = self._abstain.evaluate(
            prob_a=prob_a,
            edge=signed_edge,
            n_lines_seen=fv.n_lines_seen,
            n_core4_picks=fv.n_core4_picks,
        )
        if reason is not None:
            return self._abstain_response(event, fv, as_of, now, reason)

        pick_prob = prob_a if pick_side == "A" else 1 - prob_a
        pick_odds = quote.odds_a if pick_side == "A" else quote.odds_b
        kelly = kelly_fraction(pick_prob, pick_odds) * self._kelly_mult
        uncertainty = self._uncertainty(fv)

        rationale = (
            f"Model estimates P(side {pick_side} covers) = {pick_prob:.3f} vs a "
            f"vig-removed market probability of "
            f"{(fair_market_a if pick_side == 'A' else 1 - fair_market_a):.3f} "
            f"({self._vig_method} de-vig), an estimated edge of {signed_edge:+.3f}. "
            f"{NON_GUARANTEE_DISCLAIMER}"
        )
        return PredictionResponse(
            event_id=event.event_id,
            decision=Decision.BET,
            prob_a=round(prob_a, 4),
            pick_side=pick_side,
            edge=round(signed_edge, 4),
            kelly_fraction=round(kelly, 4),
            uncertainty=round(uncertainty, 4),
            model_version=self._version,
            feature_hash=fv.fingerprint(),
            data_as_of=as_of,
            generated_at=now,
            rationale=rationale,
        )

    def _uncertainty(self, fv) -> float:  # noqa: ANN001
        """Crude confidence band: wider when little history/consensus is available."""
        base = 0.05
        if fv.n_lines_seen < 3:
            base += 0.05
        if fv.n_core4_picks == 0:
            base += 0.03
        return min(0.5, base)

    def _abstain_response(self, event, fv, as_of, now, reason) -> PredictionResponse:  # noqa: ANN001
        return PredictionResponse(
            event_id=event.event_id,
            decision=Decision.ABSTAIN,
            abstain_reason=reason,
            model_version=self._version,
            feature_hash=fv.fingerprint(),
            data_as_of=as_of,
            generated_at=now,
            rationale=(
                f"No bet: {reason.value}. The system declines to pick when its "
                f"confidence or edge is insufficient. {NON_GUARANTEE_DISCLAIMER}"
            ),
        )
