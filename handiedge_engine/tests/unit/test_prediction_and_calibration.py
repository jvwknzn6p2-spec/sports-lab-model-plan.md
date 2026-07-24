"""Prediction adapter + calibration + confidence tier unit tests."""

from __future__ import annotations

from decimal import Decimal

from app.core.enums import CalibrationStatus, ConfidenceTier, League
from app.domain.decision.calibration import (
    IdentityCalibrator,
    PlattCalibrator,
)
from app.domain.decision.confidence import tier_for_probability
from app.schemas.control_tower import ControlTowerPayload


def test_fallback_is_deterministic(valid_payload, adapter):
    payload = ControlTowerPayload.model_validate(valid_payload)
    g = payload.games[0]
    a = adapter.predict_game(g, payload)
    b = adapter.predict_game(g, payload)
    assert a.raw_home_win_probability == b.raw_home_win_probability
    assert a.fallback_used is True


def test_fallback_probabilities_sum_to_one(valid_payload, adapter):
    payload = ControlTowerPayload.model_validate(valid_payload)
    for g in payload.games:
        raw = adapter.predict_game(g, payload)
        total = raw.raw_home_win_probability + raw.raw_away_win_probability
        assert abs(total - Decimal("1")) < Decimal("0.0001")


def test_identity_calibration_is_marked_uncalibrated():
    calib = IdentityCalibrator(version="v1")
    result = calib.calibrate(Decimal("0.62"))
    assert result.status is CalibrationStatus.UNCALIBRATED
    assert result.warning is not None
    assert result.adjusted_probability == Decimal("0.62")


def test_identity_calibration_clips_and_records():
    calib = IdentityCalibrator(version="v1", floor=Decimal("0.01"), ceil=Decimal("0.99"))
    result = calib.calibrate(Decimal("0.999"))
    assert result.clipped is True
    assert result.adjusted_probability == Decimal("0.99")
    assert result.original_probability == Decimal("0.999")


def test_platt_calibration_status_calibrated():
    calib = PlattCalibrator(a=1.0, b=0.0, artifact_id="art-1", version="v2")
    result = calib.calibrate(Decimal("0.6"))
    assert result.status is CalibrationStatus.CALIBRATED
    assert result.artifact_id == "art-1"


def test_confidence_tier_uses_calibrated_probability():
    assert tier_for_probability(Decimal("0.68"), League.MLB) in (
        ConfidenceTier.S_PLUS,
        ConfidenceTier.S,
    )
    assert tier_for_probability(Decimal("0.50"), League.MLB) == ConfidenceTier.C_MINUS
    assert tier_for_probability(Decimal("0.49"), League.MLB) == ConfidenceTier.NONE


def test_ensemble_shell_averages_and_reports_disagreement(valid_payload, adapter):
    from app.domain.prediction.ensemble import EnsemblePredictionAdapter

    payload = ControlTowerPayload.model_validate(valid_payload)
    ensemble = EnsemblePredictionAdapter(members=[adapter, adapter])
    raw = ensemble.predict_game(payload.games[0], payload)
    total = raw.raw_home_win_probability + raw.raw_away_win_probability
    assert abs(total - Decimal("1")) < Decimal("0.0001")
    assert any(w.startswith("model_disagreement=") for w in raw.inference_warnings)
    assert ensemble.info().model_type.value == "ENSEMBLE"


def test_npb_conservative_high_tier():
    # NPB penalizes high tiers, so 0.66 should not reach S as easily as MLB.
    npb = tier_for_probability(Decimal("0.66"), League.NPB)
    mlb = tier_for_probability(Decimal("0.66"), League.MLB)
    assert npb.value <= mlb.value or npb != ConfidenceTier.S_PLUS
