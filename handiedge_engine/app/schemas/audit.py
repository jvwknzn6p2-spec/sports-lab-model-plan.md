"""Audit event schema."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.core.enums import AuditEventType


class AuditEventOut(BaseModel):
    event_id: str
    event_type: AuditEventType
    aggregate_type: str
    aggregate_id: str
    actor: str
    timestamp: str
    prior_state: str | None = None
    new_state: str | None = None
    reason: str | None = None
    correlation_id: str | None = None
    causation_id: str | None = None
    payload_hash: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    """Consistent API error envelope."""

    error_code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    correlation_id: str | None = None
    timestamp: str
