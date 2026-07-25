"""Odds ingestion pipeline: validation, stale-data rejection, source reconciliation.

Responsibilities (audit category 2):
- validate every incoming quote (positive decimal odds, coherent line, aware ts);
- reject stale quotes for *decision-time* use via an explicit policy;
- keep an append-only line history per (event, market);
- reconcile multiple simultaneous sources deterministically (consensus median),
  rather than silently taking whichever arrived last;
- surface ingestion failures explicitly rather than defaulting silently.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from ..domain.taxonomy import MarketType
from ..errors import StaleDataError, ValidationError
from .models import LineHistory, OddsQuote


@dataclass(frozen=True, slots=True)
class IngestResult:
    accepted: bool
    reason: str | None = None


def validate_quote(quote: OddsQuote) -> None:
    """Raise :class:`ValidationError` if the quote is internally inconsistent."""
    if quote.odds_a <= 1.0 or quote.odds_b <= 1.0:
        raise ValidationError("decimal odds must be > 1.0 on both sides")
    if not np.isfinite(quote.odds_a) or not np.isfinite(quote.odds_b):
        raise ValidationError("odds must be finite")
    if quote.market_type in (MarketType.HANDICAP, MarketType.TOTAL) and quote.line is None:
        raise ValidationError(f"{quote.market_type} quote requires a line")
    if quote.market_type is MarketType.TOTAL and quote.line is not None and quote.line <= 0:
        raise ValidationError("total line must be positive")
    if quote.ingested_at < quote.published_at:
        # Ingested before it was published is physically impossible => clock/parse bug.
        raise ValidationError("ingested_at precedes published_at")


class OddsIngestor:
    """Validates and stores quotes; enforces the stale-data policy at read time."""

    def __init__(self, stale_seconds: int = 300) -> None:
        self.stale_seconds = stale_seconds
        self._histories: dict[tuple[uuid.UUID, MarketType], LineHistory] = {}
        self.failures: list[tuple[OddsQuote, str]] = []

    def _history(self, event_id: uuid.UUID, market: MarketType) -> LineHistory:
        key = (event_id, market)
        if key not in self._histories:
            self._histories[key] = LineHistory(event_id, market)
        return self._histories[key]

    def ingest(self, quote: OddsQuote) -> IngestResult:
        try:
            validate_quote(quote)
        except ValidationError as exc:
            self.failures.append((quote, str(exc)))
            return IngestResult(accepted=False, reason=str(exc))
        self._history(quote.event_id, quote.market_type).append(quote)
        return IngestResult(accepted=True)

    def history(self, event_id: uuid.UUID, market: MarketType) -> LineHistory:
        return self._history(event_id, market)

    def quote_for_decision(
        self, event_id: uuid.UUID, market: MarketType, as_of: datetime
    ) -> OddsQuote:
        """Return the freshest quote usable at ``as_of``; reject if stale.

        Raises :class:`StaleDataError` if the freshest available quote is older
        than the stale policy — decisions must never silently use stale odds.
        """
        hist = self._history(event_id, market)
        quote = hist.latest_before(as_of)
        if quote is None:
            raise StaleDataError("no odds available at or before as_of")
        age = quote.age_seconds(as_of)
        if age > self.stale_seconds:
            raise StaleDataError(
                f"freshest quote is {age:.0f}s old (> {self.stale_seconds}s policy)"
            )
        return quote

    def consensus_line(
        self, event_id: uuid.UUID, market: MarketType, as_of: datetime
    ) -> float | None:
        """Median handicap/total line across sources available at ``as_of``.

        Deterministic reconciliation of simultaneous sources rather than
        last-writer-wins.
        """
        avail = [q for q in self._history(event_id, market).as_of(as_of) if q.line is not None]
        if not avail:
            return None
        return float(np.median([q.line for q in avail]))
