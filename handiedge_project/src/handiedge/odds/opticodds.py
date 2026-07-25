"""OpticOdds-compatible odds adapter.

This is an *interface + configuration* only. No live connectivity is claimed and
no credentials are embedded. The HTTP transport is injectable (a ``Protocol``) so
tests use a deterministic mock; the real transport would be an ``httpx`` client.

If the adapter is used without configuration it raises :class:`NotConfigured` —
it never fabricates odds.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from ..config import Settings
from ..domain.events import require_aware
from ..domain.taxonomy import MarketType
from ..errors import NotConfigured, ValidationError
from .models import OddsQuote, OddsSource, utcnow


class Transport(Protocol):
    """Minimal transport contract the adapter depends on (dependency-injected)."""

    def get(self, path: str, params: dict[str, Any]) -> dict[str, Any]: ...


@dataclass
class OpticOddsConfig:
    base_url: str
    api_key: str
    timeout_s: float = 5.0

    @classmethod
    def from_settings(cls, settings: Settings) -> OpticOddsConfig:
        if not settings.opticodds_base_url or settings.opticodds_api_key is None:
            raise NotConfigured(
                "OpticOdds adapter requires HANDIEDGE_OPTICODDS_BASE_URL and "
                "HANDIEDGE_OPTICODDS_API_KEY; none provided (no live connectivity)."
            )
        return cls(
            base_url=settings.opticodds_base_url.rstrip("/"),
            api_key=settings.opticodds_api_key.get_secret_value(),
        )


_MARKET_MAP = {
    "point_spread": MarketType.HANDICAP,
    "spread": MarketType.HANDICAP,
    "moneyline": MarketType.MONEYLINE,
    "total": MarketType.TOTAL,
    "totals": MarketType.TOTAL,
}


def parse_quote(raw: dict[str, Any], *, ingested_at: datetime | None = None) -> OddsQuote:
    """Map an OpticOdds-shaped payload to a canonical :class:`OddsQuote`.

    Strict: unknown market types and missing timestamps are rejected, not guessed.
    """
    try:
        market = _MARKET_MAP[str(raw["market"]).lower()]
    except KeyError as exc:
        raise ValidationError(f"unmappable/absent market: {raw.get('market')!r}") from exc
    try:
        published_at = require_aware(datetime.fromisoformat(raw["published_at"]), "published_at")
        odds_a = float(raw["price_a"])
        odds_b = float(raw["price_b"])
        event_id = uuid.UUID(str(raw["event_id"]))
    except (KeyError, ValueError) as exc:
        raise ValidationError(f"malformed OpticOdds payload: {exc}") from exc

    line = raw.get("points")
    return OddsQuote(
        quote_id=uuid.uuid4(),
        event_id=event_id,
        market_type=market,
        source=OddsSource.API,
        bookmaker=str(raw.get("sportsbook", "unknown")),
        published_at=published_at,
        ingested_at=require_aware(ingested_at or utcnow(), "ingested_at"),
        odds_a=odds_a,
        odds_b=odds_b,
        line=float(line) if line is not None else None,
        is_closing=bool(raw.get("is_closing", False)),
    )


class OpticOddsAdapter:
    """OpticOdds-compatible client. Requires an injected transport and config."""

    def __init__(self, config: OpticOddsConfig, transport: Transport) -> None:
        self._config = config
        self._transport = transport

    def fetch_quotes(self, event_id: uuid.UUID) -> list[OddsQuote]:
        payload = self._transport.get(
            "/fixtures/odds",
            {"event_id": str(event_id), "key": self._config.api_key},
        )
        rows = payload.get("data", [])
        return [parse_quote(r) for r in rows]
