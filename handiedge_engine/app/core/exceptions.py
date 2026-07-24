"""Domain-specific exception hierarchy.

Every failure the pipeline can raise on purpose is a subclass of
``HandiEdgeError`` carrying a stable ``error_code`` and an HTTP status hint so
that API exception handlers can translate them consistently.
"""

from __future__ import annotations

from typing import Any


class HandiEdgeError(Exception):
    """Base class for all deliberate engine errors."""

    error_code: str = "HANDIEDGE_ERROR"
    http_status: int = 500

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details or {}

    def to_payload(self, correlation_id: str | None = None) -> dict[str, Any]:
        return {
            "error_code": self.error_code,
            "message": self.message,
            "details": self.details,
            "correlation_id": correlation_id,
        }


class ValidationError(HandiEdgeError):
    error_code = "VALIDATION_ERROR"
    http_status = 422


class ControlTowerRejectedError(HandiEdgeError):
    error_code = "CONTROL_TOWER_REJECTED"
    http_status = 422


class IdempotencyConflictError(HandiEdgeError):
    """Same run_id submitted with a different payload hash."""

    error_code = "IDEMPOTENCY_CONFLICT"
    http_status = 409


class NotFoundError(HandiEdgeError):
    error_code = "NOT_FOUND"
    http_status = 404


class HandicapParseError(HandiEdgeError):
    error_code = "HANDICAP_PARSE_ERROR"
    http_status = 422


class LockError(HandiEdgeError):
    error_code = "LOCK_ERROR"
    http_status = 409


class LockDeadlineExceededError(LockError):
    error_code = "LOCK_DEADLINE_EXCEEDED"
    http_status = 409


class ImmutableRecordError(LockError):
    error_code = "IMMUTABLE_RECORD"
    http_status = 409


class SettlementError(HandiEdgeError):
    error_code = "SETTLEMENT_ERROR"
    http_status = 422


class SettlementConflictError(SettlementError):
    error_code = "SETTLEMENT_CONFLICT"
    http_status = 409


class InvalidWorkflowTransitionError(HandiEdgeError):
    error_code = "INVALID_WORKFLOW_TRANSITION"
    http_status = 409


class ConfigurationError(HandiEdgeError):
    error_code = "CONFIGURATION_ERROR"
    http_status = 500
