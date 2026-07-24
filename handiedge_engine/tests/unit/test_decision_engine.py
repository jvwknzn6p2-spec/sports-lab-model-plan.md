"""Decision engine gate tests."""

from __future__ import annotations

import copy
from decimal import Decimal

from app.core.config import DecisionThresholds
from app.core.enums import DecisionStatus
from app.domain.decision.calibration import IdentityCalibrator
from app.domain.decision.engine import DecisionEngine
from app.domain.handicap.parser import parse_handicap
from app.schemas.control_tower import ControlTowerPayload
from app.schemas.prediction import RawGamePrediction


def _raw(match_id: str, home_p: str, warnings=()) -> RawGamePrediction:
    return RawGamePrediction(
        match_id=match_id,
        raw_home_win_probability=Decimal(home_p),
        raw_away_win_probability=(Decimal("1") - Decimal(home_p)),
        raw_team_score_expectations={"home": Decimal("4.5"), "away": Decimal("3.9")},
        raw_margin_distribution={"1": Decimal("0.5"), "-1": Decimal("0.5")},
        inference_warnings=tuple(warnings),
        fallback_used=True,
    )


def _decide(valid_payload, home_p="0.64", warnings=(), thresholds=None, mutate=None):
    data = copy.deepcopy(valid_payload)
    if mutate:
        mutate(data)
    payload = ControlTowerPayload.model_validate(data)
    game = payload.games[0]
    engine = DecisionEngine(thresholds or DecisionThresholds())
    calib = IdentityCalibrator(version="v1")
    raw = _raw(game.match_id, home_p, warnings)
    handicap = parse_handicap(game.handicap_raw, favorite=game.favorite, receiver=game.receiver)
    return engine.decide(
        game,
        payload,
        raw,
        calib.calibrate(raw.raw_home_win_probability),
        calib.calibrate(raw.raw_away_win_probability),
        handicap,
    )


def test_predicts_when_gates_pass(valid_payload):
    d = _decide(valid_payload, home_p="0.64")
    assert d.decision_status is DecisionStatus.PREDICT
    assert d.selected_team == "NYY"
    assert d.predicted_loser == "BOS"
    assert d.normal_win_probability is not None


def test_pass_when_probability_below_minimum(valid_payload):
    thresholds = DecisionThresholds(min_prediction_probability=Decimal("0.60"))
    d = _decide(valid_payload, home_p="0.55", thresholds=thresholds)
    assert d.decision_status is DecisionStatus.PASS
    assert "below minimum" in (d.pass_reason or "")


def test_pass_on_high_model_disagreement(valid_payload):
    d = _decide(valid_payload, home_p="0.64", warnings=("model_disagreement=0.40",))
    assert d.decision_status is DecisionStatus.PASS
    assert "disagreement" in (d.pass_reason or "")


def test_pass_when_starter_unconfirmed(valid_payload):
    def mutate(data):
        data["games"][0]["starter_status"] = "PROBABLE"
        for s in data["games"][0]["probable_or_confirmed_starters"]:
            s["confirmed"] = False

    d = _decide(valid_payload, mutate=mutate)
    assert d.decision_status is DecisionStatus.PASS


def test_blocked_when_schedule_unvalidated(valid_payload):
    def mutate(data):
        data["games"][0]["validation_status"] = "UNVALIDATED"

    d = _decide(valid_payload, mutate=mutate)
    assert d.decision_status is DecisionStatus.BLOCKED


def test_blocked_on_critical_risk(valid_payload):
    def mutate(data):
        data["games"][0]["risk_summary"] = {"critical_flags": ["ballpark_closed"]}

    d = _decide(valid_payload, mutate=mutate)
    assert d.decision_status is DecisionStatus.BLOCKED


def test_unresolved_handicap_blocks_handicap_only(valid_payload):
    def mutate(data):
        data["games"][0]["handicap_raw"] = "1半X"

    d = _decide(valid_payload, mutate=mutate)
    # Normal decision still predicts; handicap is blocked, not guessed.
    assert d.decision_status is DecisionStatus.PREDICT
    assert d.handicap.handicap_decision_status.value == "BLOCKED"
    assert d.handicap.handicap_cover_probability is None
