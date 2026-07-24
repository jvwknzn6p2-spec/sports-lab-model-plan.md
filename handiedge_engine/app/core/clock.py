"""Deterministic clock abstraction.

All timestamps in the engine are UTC-aware ``datetime`` objects. Tests inject a
``FixedClock`` so that hashing and audit output remain reproducible.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    """Wall-clock UTC time."""

    def now(self) -> datetime:
        return datetime.now(UTC)


class FixedClock:
    """A clock that always returns a fixed instant (for tests / reproducibility)."""

    def __init__(self, instant: datetime) -> None:
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=UTC)
        self._instant = instant.astimezone(UTC)

    def now(self) -> datetime:
        return self._instant


_DEFAULT_CLOCK: Clock = SystemClock()


def get_clock() -> Clock:
    return _DEFAULT_CLOCK


def utc_now() -> datetime:
    return _DEFAULT_CLOCK.now()


def to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def isoformat_utc(value: datetime) -> str:
    return to_utc(value).isoformat().replace("+00:00", "Z")
