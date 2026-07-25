"""Handicap ingestion — fills the empty v1.1 Chapter 8 safely (audit category 2).

Three documented ingestion paths, unified onto one validated schema and one
persistence port:
- ``parse_signal_message``  : structured "signal" text messages;
- ``HandicapCreate``        : validated web-form / API input (Pydantic);
- ``parse_handicap_image``  : OCR path (delegates to the AI gateway's OCR provider).

All three converge on :func:`to_quote` producing a canonical :class:`OddsQuote`,
then :class:`HandicapPersistPort.persist_handicap`. Canonical names follow the
v1.1 handoff map. The OCR path requires a configured gateway; without one it
raises :class:`NotConfigured` rather than fabricating a parse.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field, field_validator

from ..domain.events import require_aware
from ..domain.taxonomy import MarketType
from ..errors import NotConfigured, ValidationError
from ..odds.models import OddsQuote, OddsSource


class HandicapCreate(BaseModel):
    """Validated web/API handicap input (canonical name; replaces WebHandicapInput)."""

    event_id: uuid.UUID
    handicap_a: float = Field(description="Asian handicap applied to side A")
    odds_a: float = Field(gt=1.0)
    odds_b: float = Field(gt=1.0)
    bookmaker: str = Field(min_length=1)
    published_at: datetime
    is_closing: bool = False

    @field_validator("published_at")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        return require_aware(v, "published_at")


@runtime_checkable
class HandicapPersistPort(Protocol):
    def persist_handicap(self, quote: OddsQuote) -> None: ...


def to_quote(
    data: HandicapCreate,
    *,
    source: OddsSource,
    ingested_at: datetime | None = None,
) -> OddsQuote:
    """Convert a validated :class:`HandicapCreate` to a canonical quote."""
    return OddsQuote(
        quote_id=uuid.uuid4(),
        event_id=data.event_id,
        market_type=MarketType.HANDICAP,
        source=source,
        bookmaker=data.bookmaker,
        published_at=data.published_at,
        ingested_at=require_aware(ingested_at or datetime.now(UTC), "ingested_at"),
        odds_a=data.odds_a,
        odds_b=data.odds_b,
        line=data.handicap_a,
        is_closing=data.is_closing,
    )


# --- signal-message path -----------------------------------------------------

_SIGNAL_RE = re.compile(
    r"EVENT=(?P<event>[0-9a-fA-F-]{36})\s+"
    r"HA=(?P<ha>[-+]?\d+(?:\.\d+)?)\s+"
    r"OA=(?P<oa>\d+(?:\.\d+)?)\s+"
    r"OB=(?P<ob>\d+(?:\.\d+)?)\s+"
    r"BOOK=(?P<book>\S+)\s+"
    r"AT=(?P<at>\S+)"
)


def parse_signal_message(message: str) -> HandicapCreate:
    """Parse a structured signal message into a validated :class:`HandicapCreate`.

    Strict: a non-matching message raises rather than guessing.
    """
    m = _SIGNAL_RE.search(message.strip())
    if not m:
        raise ValidationError("signal message did not match the expected schema")
    return HandicapCreate(
        event_id=uuid.UUID(m.group("event")),
        handicap_a=float(m.group("ha")),
        odds_a=float(m.group("oa")),
        odds_b=float(m.group("ob")),
        bookmaker=m.group("book"),
        published_at=datetime.fromisoformat(m.group("at")),
    )


# --- OCR path ----------------------------------------------------------------


@runtime_checkable
class OCRGateway(Protocol):
    """Minimal contract for an OCR-capable gateway (routes OCR to a vision model)."""

    def extract_json(self, image_bytes: bytes) -> dict[str, Any]: ...


def parse_handicap_image(gateway: OCRGateway | None, image_bytes: bytes) -> HandicapCreate:
    """Canonical OCR entry point: parse a handicap board image via the gateway.

    Keyword-consistent signature per the v1.1 naming map. Without a configured
    gateway this raises :class:`NotConfigured` — it does not invent a result.
    """
    if gateway is None:
        raise NotConfigured(
            "OCR gateway not configured; cannot extract handicap from image. "
            "Provide an OCRGateway backed by a vision provider."
        )
    raw = gateway.extract_json(image_bytes)
    try:
        return HandicapCreate(
            event_id=uuid.UUID(str(raw["event_id"])),
            handicap_a=float(raw["handicap_a"]),
            odds_a=float(raw["odds_a"]),
            odds_b=float(raw["odds_b"]),
            bookmaker=str(raw["bookmaker"]),
            published_at=datetime.fromisoformat(str(raw["published_at"])),
        )
    except (KeyError, ValueError) as exc:
        raise ValidationError(f"OCR payload could not be validated: {exc}") from exc


class InMemoryHandicapStore:
    """A persistence adapter usable offline (stands in for the DB-backed port)."""

    def __init__(self) -> None:
        self.quotes: list[OddsQuote] = []

    def persist_handicap(self, quote: OddsQuote) -> None:
        self.quotes.append(quote)
