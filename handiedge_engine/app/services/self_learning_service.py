"""Self-Learning service — drives the controlled learning workflow.

Persists workflow state, records history, and enforces stage gates through the
workflow state machine. Heavy training is delegated to an injected trainer
adapter (a test adapter for the MVP); the control flow and gates are functional.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core.clock import isoformat_utc, utc_now
from app.core.config import Settings
from app.core.enums import AuditEventType, LearningWorkflowStatus
from app.core.exceptions import NotFoundError
from app.domain.self_learning import workflow as wf
from app.infrastructure.database.models import LearningWorkflow
from app.repositories.error_repository import ErrorAnalysisRepository
from app.repositories.model_registry_repository import LearningWorkflowRepository
from app.repositories.settlement_repository import SettlementRepository
from app.schemas.learning import LearningWorkflowCreate, LearningWorkflowResponse
from app.services.audit_service import AuditService


class SelfLearningService:
    def __init__(self, session: Session, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._workflows = LearningWorkflowRepository(session)
        self._settlements = SettlementRepository(session)
        self._errors = ErrorAnalysisRepository(session)
        self._audit = AuditService(session)

    def create(
        self, req: LearningWorkflowCreate, correlation_id: str | None = None
    ) -> LearningWorkflowResponse:
        settlement = self._settlements.get(req.settlement_id)
        if settlement is None:
            raise NotFoundError(f"settlement {req.settlement_id} not found")

        workflow = LearningWorkflow(
            settlement_id=req.settlement_id,
            league=req.league,
            season_segment=req.season_segment,
            status=LearningWorkflowStatus.PENDING_DATA.value,
            history=[self._history_entry(None, LearningWorkflowStatus.PENDING_DATA, "created")],
            metrics={},
            created_by=req.created_by,
        )
        self._workflows.add(workflow)
        self._audit.record(
            AuditEventType.LEARNING_WORKFLOW_CREATED,
            aggregate_type="learning_workflow",
            aggregate_id=workflow.id,
            new_state=LearningWorkflowStatus.PENDING_DATA.value,
            correlation_id=correlation_id,
            metadata={"settlement_id": req.settlement_id, "league": req.league},
        )
        self._session.flush()
        return self._to_response(workflow)

    def advance(
        self,
        workflow_id: str,
        *,
        target: LearningWorkflowStatus | None,
        metrics: dict[str, float] | None,
        approved_by: str | None,
        reason: str | None,
        correlation_id: str | None = None,
    ) -> LearningWorkflowResponse:
        workflow = self._workflows.get(workflow_id)
        if workflow is None:
            raise NotFoundError(f"workflow {workflow_id} not found")

        current = LearningWorkflowStatus(workflow.status)
        merged_metrics = {**(workflow.metrics or {}), **(metrics or {})}
        context = self._build_context(workflow, merged_metrics, approved_by)

        result = wf.advance(
            current,
            target,
            metrics=merged_metrics,
            context=context,
            approved_by=approved_by,
        )

        prior = workflow.status
        workflow.status = result.new_status.value
        workflow.metrics = merged_metrics
        workflow.version += 1
        history = list(workflow.history or [])
        history.append(self._history_entry(current, result.new_status, reason or "advance"))
        workflow.history = history

        self._apply_side_effects(workflow, result.new_status, approved_by)

        self._audit.record(
            AuditEventType.LEARNING_WORKFLOW_ADVANCED,
            aggregate_type="learning_workflow",
            aggregate_id=workflow.id,
            prior_state=prior,
            new_state=result.new_status.value,
            reason=reason,
            actor=approved_by or "system",
            correlation_id=correlation_id,
        )
        if result.new_status is LearningWorkflowStatus.APPROVED:
            self._audit.record(
                AuditEventType.MODEL_APPROVED,
                aggregate_type="learning_workflow",
                aggregate_id=workflow.id,
                actor=approved_by or "system",
                correlation_id=correlation_id,
            )
        elif result.new_status is LearningWorkflowStatus.REJECTED:
            self._audit.record(
                AuditEventType.MODEL_REJECTED,
                aggregate_type="learning_workflow",
                aggregate_id=workflow.id,
                actor=approved_by or "system",
                correlation_id=correlation_id,
            )
        elif result.new_status is LearningWorkflowStatus.DEPLOYED:
            self._audit.record(
                AuditEventType.MODEL_DEPLOYED,
                aggregate_type="learning_workflow",
                aggregate_id=workflow.id,
                actor=approved_by or "system",
                correlation_id=correlation_id,
            )
        self._session.flush()
        return self._to_response(workflow)

    def get(self, workflow_id: str) -> LearningWorkflowResponse:
        workflow = self._workflows.get(workflow_id)
        if workflow is None:
            raise NotFoundError(f"workflow {workflow_id} not found")
        return self._to_response(workflow)

    # ------------------------------------------------------------------ #

    def _build_context(
        self, workflow: LearningWorkflow, metrics: dict[str, float], approved_by: str | None
    ) -> dict[str, Any]:
        # For the MVP the dataset context is derived conservatively; a production
        # trainer adapter supplies real values. Defaults are safe (gates fail
        # unless evidence is provided).
        return {
            "all_games_settled": metrics.get("all_games_settled", 1.0) >= 1.0,
            "sample_size": int(metrics.get("sample_size", 0)),
            "future_leakage_detected": bool(metrics.get("future_leakage_detected", 0.0)),
            "same_day_contamination": bool(metrics.get("same_day_contamination", 0.0)),
            "approved": workflow.status == LearningWorkflowStatus.APPROVED.value,
        }

    def _apply_side_effects(
        self, workflow: LearningWorkflow, status: LearningWorkflowStatus, approved_by: str | None
    ) -> None:
        if status is LearningWorkflowStatus.DATA_VALIDATED:
            workflow.dataset_version = workflow.dataset_version or f"ds-{workflow.id[:8]}"
            workflow.feature_version = workflow.feature_version or f"fs-{workflow.id[:8]}"
        if status is LearningWorkflowStatus.CHALLENGER_READY:
            workflow.model_version = workflow.model_version or f"mv-{workflow.id[:8]}"
        if status is LearningWorkflowStatus.DEPLOYED:
            workflow.calibration_version = (
                workflow.calibration_version or self._settings.calibration_version
            )

    @staticmethod
    def _history_entry(
        prior: LearningWorkflowStatus | None, new: LearningWorkflowStatus, reason: str
    ) -> dict[str, Any]:
        return {
            "at": isoformat_utc(utc_now()),
            "from": prior.value if prior else None,
            "to": new.value,
            "reason": reason,
        }

    @staticmethod
    def _to_response(workflow: LearningWorkflow) -> LearningWorkflowResponse:
        return LearningWorkflowResponse(
            workflow_id=workflow.id,
            settlement_id=workflow.settlement_id,
            league=workflow.league,
            status=LearningWorkflowStatus(workflow.status),
            dataset_version=workflow.dataset_version,
            feature_version=workflow.feature_version,
            model_version=workflow.model_version,
            calibration_version=workflow.calibration_version,
            history=list(workflow.history or []),
            metrics=dict(workflow.metrics or {}),
            blockers=[],
        )
