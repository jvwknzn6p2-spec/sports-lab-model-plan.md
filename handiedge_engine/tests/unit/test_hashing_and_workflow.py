"""Hashing determinism, workflow transitions, and error classification."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.enums import ErrorCategory, PredictionResult, SettlementStatus
from app.core.enums import LearningWorkflowStatus as S
from app.core.exceptions import InvalidWorkflowTransitionError
from app.core.hashing import sha256_hex
from app.domain.error_analysis.engine import analyze
from app.domain.self_learning import workflow as wf
from app.domain.settlement.engine import SettlementOutcome


def test_hash_is_order_independent():
    a = {"x": 1, "y": [1, 2], "z": Decimal("0.5")}
    b = {"z": Decimal("0.5"), "y": [1, 2], "x": 1}
    assert sha256_hex(a) == sha256_hex(b)


def test_hash_changes_with_content():
    assert sha256_hex({"x": 1}) != sha256_hex({"x": 2})


def test_workflow_valid_forward_transition():
    result = wf.advance(
        S.PENDING_DATA,
        None,
        metrics={"sample_size": 500, "all_games_settled": 1.0},
        context={"all_games_settled": True, "sample_size": 500},
    )
    assert result.new_status is S.DATA_VALIDATED


def test_workflow_invalid_transition_rejected():
    with pytest.raises(InvalidWorkflowTransitionError):
        wf.advance(S.PENDING_DATA, S.DEPLOYED, metrics={}, context={})


def test_workflow_gate_blocks_insufficient_samples():
    with pytest.raises(InvalidWorkflowTransitionError):
        wf.advance(
            S.PENDING_DATA,
            S.DATA_VALIDATED,
            metrics={},
            context={"all_games_settled": True, "sample_size": 10},
        )


def test_workflow_approval_requires_approver_and_improvement():
    with pytest.raises(InvalidWorkflowTransitionError):
        wf.advance(
            S.APPROVAL_REQUIRED,
            S.APPROVED,
            metrics={"challenger_brier": 0.25, "champion_brier": 0.20},
            context={},
            approved_by="lead",
        )


def _outcome(result, score_home, score_away, handicap=PredictionResult.LOSS):
    return SettlementOutcome(
        settlement_status=SettlementStatus.SETTLED,
        normal_result=result,
        handicap_result=handicap,
        winning_team="BOS",
        losing_team="NYY",
        score_home=score_home,
        score_away=score_away,
        push=False,
        partial_win=False,
        partial_loss=False,
        void_reason=None,
    )


def test_error_analysis_confident_loss_flags_model_misread():
    ctx = {
        "selected_team": "NYY",
        "home": "NYY",
        "normal_win_probability": 0.66,
        "expected_score_home": 5.0,
        "expected_score_away": 3.0,
        "risk_factors": [],
    }
    result = analyze(ctx, _outcome(PredictionResult.LOSS, 1, 8))
    assert result.brier_contribution is not None
    assert result.retraining_eligibility is True
    cats = [result.primary_error_category, *result.secondary_error_categories]
    assert ErrorCategory.MODEL_MISREAD in cats or ErrorCategory.HIGH_VARIANCE_EVENT in cats


def test_error_analysis_void_has_no_error_signal():
    result = analyze(
        {"selected_team": "NYY", "normal_win_probability": 0.6},
        SettlementOutcome(
            settlement_status=SettlementStatus.VOID,
            normal_result=PredictionResult.VOID,
            handicap_result=PredictionResult.VOID,
            winning_team=None,
            losing_team=None,
            score_home=None,
            score_away=None,
            push=False,
            partial_win=False,
            partial_loss=False,
            void_reason="game postponed",
        ),
    )
    assert result.primary_error_category is ErrorCategory.UNKNOWN
    assert result.retraining_eligibility is False
