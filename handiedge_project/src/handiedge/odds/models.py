"""Odds quote model and append-only line history (audit category 2).

Every quote records: bookmaker/source identity, the time it was published live in
the market (``published_at``), and the time we ingested it (``ingested_at``) — the
two are distinguished. Line history is append-only so CLV and as-of features can be
reconstructed; nothing is overwritten in place.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum

from ..domain.events import require_aware
from ..domain.taxonomy import MarketType


class OddsSource(str, Enum):
    SIGNAL_INGEST = "signal_ingest"
    WEB_INPUT = "web_input"
    OCR = "ocr"
    API = "api"


@dataclass(frozen=True, slots=True)
class OddsQuote:
    """A single two-sided quote for a handicap/total/moneyline market."""

    quote_id: uuid.UUID
    event_id: uuid.UUID
    market_type: MarketType
    source: OddsSource
    bookmaker: str
    published_at: datetime  # when the line was live in the market (UTC)
    ingested_at: datetime  # when we received it (UTC)
    odds_a: float  # decimal odds for side A / OVER
    odds_b: float  # decimal odds for side B / UNDER
    line: float | None = None  # handicap on A / total points; None for moneyline
    is_closing: bool = False
    ingest_trace_id: uuid.UUID = field(default_factory=uuid.uuid4)

    def __post_init__(self) -> None:
        object.__setattr__(self, "published_at", require_aware(self.published_at, "published_at"))
        object.__setattr__(self, "ingested_at", require_aware(self.ingested_at, "ingested_at"))

    def age_seconds(self, as_of: datetime) -> float:
        as_of = require_aware(as_of, "as_of")
        return (as_of - self.published_at).total_seconds()


class LineHistory:
    """Append-only, time-ordered store of quotes for a single event+market.

    Enforces temporal integrity: quotes are indexed by ``published_at`` and never
    mutated. ``as_of`` reads return only quotes published on or before the cutoff,
    which is the primitive the feature builder relies on for leakage safety.
    """

    def __init__(self, event_id: uuid.UUID, market_type: MarketType) -> None:
        self.event_id = event_id
        self.market_type = market_type
        self._quotes: list[OddsQuote] = []

    def append(self, quote: OddsQuote) -> None:
        if quote.event_id != self.event_id or quote.market_type != self.market_type:
            raise ValueError("quote does not belong to this line history")
        self._quotes.append(quote)
        self._quotes.sort(key=lambda q: q.published_at)

    def __len__(self) -> int:
        return len(self._quotes)

    def all(self) -> list[OddsQuote]:
        return list(self._quotes)

    def as_of(self, cutoff: datetime) -> list[OddsQuote]:
        cutoff = require_aware(cutoff, "cutoff")
        return [q for q in self._quotes if q.published_at <= cutoff]

    def latest_before(self, cutoff: datetime) -> OddsQuote | None:
        avail = self.as_of(cutoff)
        return avail[-1] if avail else None

    def opening(self) -> OddsQuote | None:
        return self._quotes[0] if self._quotes else None

    def closing(self) -> OddsQuote | None:
        """The line flagged is_closing, else the last published quote."""
        closers = [q for q in self._quotes if q.is_closing]
        if closers:
            return closers[-1]
        return self._quotes[-1] if self._quotes else None


def utcnow() -> datetime:
    return datetime.now(UTC)
