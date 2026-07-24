"""Audit service — records every meaningful state transition as an audit event."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core.clock import utc_now
from app.core.enums import AuditEventType
from app.infrastructure.database.models import AuditEvent
from app.repositories.error_repository import AuditRepository


class AuditService:
    def __init__(self, session: Session) -> None:
        self._repo = AuditRepository(session)

    def record(
        self,
        event_type: AuditEventType,
        aggregate_type: str,
        aggregate_id: str,
        *,
        actor: str = "system",
        prior_state: str | None = None,
        new_state: str | None = None,
        reason: str | None = None,
        correlation_id: str | None = None,
        causation_id: str | None = None,
        payload_hash: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> AuditEvent:
        event = AuditEvent(
            event_type=event_type.value,
            aggregate_type=aggregate_type,
            aggregate_id=aggregate_id,
            actor=actor,
            event_timestamp=utc_now(),
            prior_state=prior_state,
            new_state=new_state,
            reason=reason,
            correlation_id=correlation_id,
            causation_id=causation_id,
            payload_hash=payload_hash,
            event_metadata=metadata or {},
        )
        return self._repo.add(event)

    def history(self, aggregate_id: str) -> list[AuditEvent]:
        return self._repo.find_by_aggregate(aggregate_id)
