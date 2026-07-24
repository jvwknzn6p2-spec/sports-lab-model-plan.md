"""Error Analysis service — generates and persists post-settlement analysis."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.enums import (
    AuditEventType,
    PredictionResult,
    SettlementStatus,
)
from app.core.exceptions import NotFoundError
from app.domain.error_analysis.engine import analyze
from app.domain.settlement.engine import SettlementOutcome
from app.infrastructure.database.models import ErrorAnalysisRecord
from app.repositories.error_repository import ErrorAnalysisRepository
from app.repositories.lock_repository import LockRepository
from app.repositories.settlement_repository import SettlementRepository
from app.schemas.error_analysis import ErrorAnalysisResponse
from app.services.audit_service import AuditService


class ErrorAnalysisService:
    def __init__(self, session: Session, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._settlements = SettlementRepository(session)
        self._locks = LockRepository(session)
        self._errors = ErrorAnalysisRepository(session)
        self._audit = AuditService(session)

    def analyze_settlement(
        self, settlement_id: str, correlation_id: str | None = None
    ) -> ErrorAnalysisResponse:
        settlement = self._settlements.get(settlement_id)
        if settlement is None:
            raise NotFoundError(f"settlement {settlement_id} not found")

        existing = self._errors.find_by_settlement(settlement_id)
        if existing is not None:
            return ErrorAnalysisResponse.model_validate(existing.payload)

        lock = self._locks.get(settlement.prediction_lock_id)
        if lock is None:
            raise NotFoundError(f"lock {settlement.prediction_lock_id} not found")

        outcome = self._reconstruct_outcome(settlement)
        result = analyze(prediction_ctx=lock.final_prediction, outcome=outcome)

        response = ErrorAnalysisResponse(
            error_analysis_id="",
            settlement_id=settlement_id,
            prediction_lock_id=settlement.prediction_lock_id,
            prediction_error=result.prediction_error,
            brier_contribution=result.brier_contribution,
            log_loss_contribution=result.log_loss_contribution,
            calibration_bucket=result.calibration_bucket,
            expected_margin_error=result.expected_margin_error,
            actual_margin=result.actual_margin,
            primary_error_category=result.primary_error_category,
            secondary_error_categories=result.secondary_error_categories,
            observed_evidence=result.observed_evidence,
            derived_metrics=result.derived_metrics,
            hypotheses=result.hypotheses,
            recommended_follow_up=result.recommended_follow_up,
            retraining_eligibility=result.retraining_eligibility,
        )
        record = ErrorAnalysisRecord(
            settlement_id=settlement_id,
            prediction_lock_id=settlement.prediction_lock_id,
            primary_error_category=result.primary_error_category.value,
            retraining_eligibility=result.retraining_eligibility,
            payload={},
        )
        self._errors.add(record)
        response.error_analysis_id = record.id
        record.payload = response.model_dump(mode="json")

        self._audit.record(
            AuditEventType.ERROR_ANALYSIS_GENERATED,
            aggregate_type="error_analysis",
            aggregate_id=record.id,
            correlation_id=correlation_id,
            metadata={
                "settlement_id": settlement_id,
                "primary_category": result.primary_error_category.value,
            },
        )
        self._session.flush()
        return response

    def get(self, error_analysis_id: str) -> ErrorAnalysisResponse:
        record = self._errors.get(error_analysis_id)
        if record is None:
            raise NotFoundError(f"error analysis {error_analysis_id} not found")
        return ErrorAnalysisResponse.model_validate(record.payload)

    @staticmethod
    def _reconstruct_outcome(settlement) -> SettlementOutcome:
        p = settlement.payload
        return SettlementOutcome(
            settlement_status=SettlementStatus(settlement.settlement_status),
            normal_result=PredictionResult(settlement.normal_prediction_result),
            handicap_result=PredictionResult(settlement.handicap_prediction_result),
            winning_team=p.get("winning_team"),
            losing_team=p.get("losing_team"),
            score_home=p.get("settlement_score_home"),
            score_away=p.get("settlement_score_away"),
            push=p.get("push", False),
            partial_win=p.get("partial_win", False),
            partial_loss=p.get("partial_loss", False),
            void_reason=p.get("void_reason"),
        )
