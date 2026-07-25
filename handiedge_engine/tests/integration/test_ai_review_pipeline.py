"""Integration tests: the AI review stage inside the full prediction pipeline."""

from __future__ import annotations

import copy

import pytest

from app.core.enums import AuditEventType
from app.services.audit_service import AuditService
from app.services.orchestration_service import OrchestrationService

pytestmark = pytest.mark.integration


def _run(session, settings, adapter, payload):
    return OrchestrationService(session, settings, adapter).run_pipeline(
        payload, correlation_id="ai-itest"
    )


def test_pipeline_attaches_ai_review_to_every_game(session, settings, adapter, valid_payload):
    from app.core.enums import ConfidenceTier
    from app.domain.ai_review.confidence import tier_index

    resp = _run(session, settings, adapter, valid_payload)
    for game in resp.games:
        assert game.ai_review is not None
        assert game.ai_review.reviewed is True
        assert game.ai_review.provider == "heuristic"
        assert len(game.ai_review.verdicts) == 3
        # Invariant: the reviewed tier shown must equal the review's final tier,
        # and can only be equal to or worse than the pre-review tier.
        assert game.ai_review.final_tier == game.confidence_tier
        assert tier_index(ConfidenceTier(game.ai_review.final_tier)) >= tier_index(
            ConfidenceTier(game.ai_review.original_tier)
        )


def test_pipeline_records_ai_review_audit_event(session, settings, adapter, valid_payload):
    resp = _run(session, settings, adapter, valid_payload)
    session.flush()
    history = AuditService(session).history(resp.games[0].audit.prediction_id)
    event_types = {e.event_type for e in history}
    assert AuditEventType.AI_REVIEW_APPLIED.value in event_types


def test_pipeline_downgrades_confidence_on_degraded_data(
    session, settings, adapter, valid_payload
):
    # Unconfirmed starter + no odds -> Data Auditor criticals -> cap at C.
    payload = copy.deepcopy(valid_payload)
    payload["run_id"] = "run-degraded-itest"
    # Relax the starter gate so the game still PREDICTs and the AI cap is visible
    # on a real tier rather than being pre-empted by a PASS.
    settings.thresholds.require_starter_confirmation = False
    game = payload["games"][0]
    game["probable_or_confirmed_starters"][0]["confirmed"] = False
    game["starter_status"] = "PROJECTED"
    game["odds_summary"] = {}
    game["market_summary"] = {}
    payload["games"] = [game]

    resp = _run(session, settings, adapter, payload)
    reviewed = resp.games[0]
    assert reviewed.decision_status == "PREDICT"
    assert reviewed.ai_review.downgraded is True
    # Final coarse family is C (informational only).
    assert reviewed.confidence_tier.startswith("C")
    codes = {f.code for f in reviewed.ai_review.flags}
    assert {"UNCONFIRMED_STARTER", "MISSING_ODDS"} <= codes


def test_ai_review_can_be_disabled(session, settings, adapter, valid_payload):
    settings.ai_review_enabled = False
    resp = _run(session, settings, adapter, valid_payload)
    assert all(g.ai_review is None for g in resp.games)


def test_context_adapter_reads_control_tower_fields(settings, valid_payload):
    """The context builder maps HandiEdge domain objects into the agent view."""
    from decimal import Decimal

    from app.domain.ai_review.context import build_review_context
    from app.domain.ai_review.types import ReviewRank
    from app.schemas.control_tower import ControlTowerPayload

    payload = ControlTowerPayload.model_validate(valid_payload)
    game = payload.games[0]

    from app.domain.prediction.deterministic_fallback import DeterministicFallbackAdapter

    raw = DeterministicFallbackAdapter().predict_game(game, payload)

    from app.schemas.decision import GameDecision

    decision = GameDecision(match_id=game.match_id)
    ctx = build_review_context(
        game, payload, raw, decision, Decimal("0.64"), Decimal("0.36"), prediction_id="pid"
    )
    assert ctx.schedule_confirmed is True
    assert ctx.home_starter is not None and ctx.home_starter.confirmed is True
    assert ctx.odds_available is True
    assert ctx.staleness_minutes is not None
    # NONE tier collapses to coarse C.
    assert ctx.original_tier_rank is ReviewRank.C
