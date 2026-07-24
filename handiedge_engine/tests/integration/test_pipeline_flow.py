"""End-to-end lifecycle integration tests (SQLite-backed)."""

from __future__ import annotations

import copy

import pytest

from app.core.enums import LearningWorkflowStatus
from app.core.exceptions import (
    ControlTowerRejectedError,
    IdempotencyConflictError,
    SettlementConflictError,
)
from app.schemas.learning import LearningWorkflowCreate
from app.schemas.settlement import SettlementInput
from app.services.error_analysis_service import ErrorAnalysisService
from app.services.orchestration_service import OrchestrationService
from app.services.prediction_lock_service import PredictionLockService
from app.services.self_learning_service import SelfLearningService
from app.services.settlement_service import SettlementService

pytestmark = pytest.mark.integration


def _run(session, settings, adapter, payload):
    service = OrchestrationService(session, settings, adapter)
    return service.run_pipeline(payload, correlation_id="itest")


def test_valid_payload_to_prediction(session, settings, adapter, valid_payload):
    resp = _run(session, settings, adapter, valid_payload)
    assert resp.run_id == valid_payload["run_id"]
    assert resp.summary.total_games == 2
    assert resp.model_context.fallback_used is True
    # First game has 1半 handicap -> handicap output present and independent.
    game = resp.games[0]
    assert game.handicap_rule_status == "RESOLVED"


def test_invalid_payload_rejected(session, settings, adapter, examples_dir):
    import json

    bad = json.loads((examples_dir / "control_tower_invalid.json").read_text())
    with pytest.raises(ControlTowerRejectedError):
        _run(session, settings, adapter, bad)


def test_idempotent_duplicate_returns_same(session, settings, adapter, valid_payload):
    r1 = _run(session, settings, adapter, valid_payload)
    session.commit()
    r2 = _run(session, settings, adapter, valid_payload)
    assert r1.model_dump() == r2.model_dump()


def test_conflicting_payload_detected(session, settings, adapter, valid_payload):
    _run(session, settings, adapter, valid_payload)
    session.commit()
    conflicting = copy.deepcopy(valid_payload)
    conflicting["games"][0]["favorite"] = "BOS"
    conflicting["games"][0]["receiver"] = "NYY"
    with pytest.raises(IdempotencyConflictError):
        _run(session, settings, adapter, conflicting)


def test_full_lifecycle_predict_lock_settle_error_learning(
    session, settings, adapter, valid_payload
):
    resp = _run(session, settings, adapter, valid_payload)
    session.commit()

    prediction_id = resp.games[0].audit.prediction_id

    lock_service = PredictionLockService(session, settings)
    lock = lock_service.lock(prediction_id, correlation_id="itest")
    session.commit()
    assert lock.lock_status.value == "LOCKED"

    # Duplicate lock is idempotent.
    lock2 = lock_service.lock(prediction_id, correlation_id="itest")
    assert lock2.prediction_lock_id == lock.prediction_lock_id

    # Settlement (MLB final incl extra).
    settle_service = SettlementService(session, settings)
    si = SettlementInput.model_validate(
        {
            "prediction_lock_id": lock.prediction_lock_id,
            "official_game_id": "746321",
            "final_score": {"home": 6, "away": 4},
            "regulation_score": {"home": 6, "away": 4},
            "game_status": "FINAL",
            "official_result_source": "MLB_STATS_API",
            "official_result_timestamp": "2026-07-25T03:15:00Z",
        }
    )
    settlement = settle_service.settle(si, correlation_id="itest")
    session.commit()
    assert settlement.settlement_status.value == "SETTLED"
    assert settlement.settlement_score_home == 6

    # Idempotent settlement replay.
    again = settle_service.settle(si, correlation_id="itest")
    assert again.settlement_id == settlement.settlement_id

    # Error analysis from settlement.
    err_service = ErrorAnalysisService(session, settings)
    analysis = err_service.analyze_settlement(settlement.settlement_id, correlation_id="itest")
    session.commit()
    assert analysis.settlement_id == settlement.settlement_id

    # Learning workflow.
    learn_service = SelfLearningService(session, settings)
    wf = learn_service.create(
        LearningWorkflowCreate(settlement_id=settlement.settlement_id, league="MLB"),
        correlation_id="itest",
    )
    session.commit()
    assert wf.status is LearningWorkflowStatus.PENDING_DATA

    advanced = learn_service.advance(
        wf.workflow_id,
        target=None,
        metrics={"sample_size": 500, "all_games_settled": 1.0},
        approved_by=None,
        reason="validated",
        correlation_id="itest",
    )
    assert advanced.status is LearningWorkflowStatus.DATA_VALIDATED


def test_settlement_conflict_detected(session, settings, adapter, valid_payload):
    resp = _run(session, settings, adapter, valid_payload)
    session.commit()
    prediction_id = resp.games[0].audit.prediction_id
    lock = PredictionLockService(session, settings).lock(prediction_id)
    session.commit()

    settle_service = SettlementService(session, settings)
    first = {
        "prediction_lock_id": lock.prediction_lock_id,
        "final_score": {"home": 6, "away": 4},
        "regulation_score": {"home": 6, "away": 4},
        "game_status": "FINAL",
        "official_result_source": "SOURCE_A",
        "official_result_timestamp": "2026-07-25T03:15:00Z",
    }
    settle_service.settle(SettlementInput.model_validate(first))
    session.commit()

    conflicting = dict(first)
    conflicting["final_score"] = {"home": 2, "away": 9}
    conflicting["official_result_source"] = "SOURCE_B"
    with pytest.raises(SettlementConflictError):
        settle_service.settle(SettlementInput.model_validate(conflicting))
