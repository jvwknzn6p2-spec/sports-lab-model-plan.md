"""Control Tower validation, hashing, and idempotency."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.orm import Session

from app.core.exceptions import (
    ControlTowerRejectedError,
    IdempotencyConflictError,
)
from app.core.hashing import sha256_hex
from app.infrastructure.database.models import PredictionRun
from app.repositories.prediction_repository import PredictionRepository
from app.schemas.control_tower import ControlTowerPayload


@dataclass
class ValidatedPayload:
    payload: ControlTowerPayload
    payload_hash: str
    existing_run: PredictionRun | None


class ControlTowerValidationService:
    def __init__(self, session: Session, max_games: int) -> None:
        self._session = session
        self._repo = PredictionRepository(session)
        self._max_games = max_games

    def validate(self, raw: dict[str, Any]) -> ValidatedPayload:
        try:
            payload = ControlTowerPayload.model_validate(raw)
        except PydanticValidationError as exc:
            raise ControlTowerRejectedError(
                "Control Tower payload failed validation",
                details={
                    "errors": exc.errors(include_url=False, include_context=False)
                },
            ) from exc

        if len(payload.games) > self._max_games:
            raise ControlTowerRejectedError(
                f"too many games in run ({len(payload.games)} > {self._max_games})"
            )

        payload_hash = self._hash(payload)
        existing = self._repo.get_run_by_run_id(payload.run_id)
        if existing is not None and existing.payload_hash != payload_hash:
            raise IdempotencyConflictError(
                f"run_id {payload.run_id} already submitted with a different payload",
                details={
                    "existing_hash": existing.payload_hash,
                    "submitted_hash": payload_hash,
                },
            )
        return ValidatedPayload(payload=payload, payload_hash=payload_hash, existing_run=existing)

    @staticmethod
    def _hash(payload: ControlTowerPayload) -> str:
        canonical = payload.model_dump(mode="json")
        return sha256_hex(canonical)
