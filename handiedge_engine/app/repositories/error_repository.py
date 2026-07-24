"""Persistence for error-analysis records and audit events."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.infrastructure.database.models import AuditEvent, ErrorAnalysisRecord


class ErrorAnalysisRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, error_analysis_id: str) -> ErrorAnalysisRecord | None:
        return self.session.get(ErrorAnalysisRecord, error_analysis_id)

    def find_by_settlement(self, settlement_id: str) -> ErrorAnalysisRecord | None:
        stmt = select(ErrorAnalysisRecord).where(
            ErrorAnalysisRecord.settlement_id == settlement_id
        )
        return self.session.scalars(stmt).one_or_none()

    def add(self, record: ErrorAnalysisRecord) -> ErrorAnalysisRecord:
        self.session.add(record)
        self.session.flush()
        return record


class AuditRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def add(self, event: AuditEvent) -> AuditEvent:
        self.session.add(event)
        self.session.flush()
        return event

    def find_by_aggregate(self, aggregate_id: str) -> list[AuditEvent]:
        stmt = (
            select(AuditEvent)
            .where(AuditEvent.aggregate_id == aggregate_id)
            .order_by(AuditEvent.event_timestamp)
        )
        return list(self.session.scalars(stmt).all())
