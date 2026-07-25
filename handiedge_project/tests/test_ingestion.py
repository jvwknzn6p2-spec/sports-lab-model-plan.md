"""Odds ingestion + Chapter 8 handicap ingestion + OpticOdds adapter tests
(audit category 2)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from handiedge.domain.taxonomy import MarketType
from handiedge.errors import NotConfigured, StaleDataError, ValidationError
from handiedge.ingest.handicap import (
    HandicapCreate,
    InMemoryHandicapStore,
    parse_handicap_image,
    parse_signal_message,
    to_quote,
)
from handiedge.odds.ingestion import OddsIngestor
from handiedge.odds.models import OddsQuote, OddsSource
from handiedge.odds.opticodds import OpticOddsAdapter, OpticOddsConfig, parse_quote


def _quote(event_id, pub, **kw):
    base = dict(
        quote_id=uuid.uuid4(),
        event_id=event_id,
        market_type=MarketType.HANDICAP,
        source=OddsSource.API,
        bookmaker="bookA",
        published_at=pub,
        ingested_at=pub,
        odds_a=1.91,
        odds_b=1.91,
        line=-1.5,
    )
    base.update(kw)
    return OddsQuote(**base)


def test_stale_quote_rejected_for_decision():
    ev = uuid.uuid4()
    now = datetime(2026, 8, 1, tzinfo=UTC)
    ing = OddsIngestor(stale_seconds=300)
    ing.ingest(_quote(ev, now - timedelta(seconds=600)))
    with pytest.raises(StaleDataError):
        ing.quote_for_decision(ev, MarketType.HANDICAP, now)


def test_fresh_quote_accepted():
    ev = uuid.uuid4()
    now = datetime(2026, 8, 1, tzinfo=UTC)
    ing = OddsIngestor(stale_seconds=300)
    ing.ingest(_quote(ev, now - timedelta(seconds=60)))
    q = ing.quote_for_decision(ev, MarketType.HANDICAP, now)
    assert q.line == -1.5


def test_invalid_odds_recorded_as_failure():
    ev = uuid.uuid4()
    now = datetime(2026, 8, 1, tzinfo=UTC)
    ing = OddsIngestor()
    res = ing.ingest(_quote(ev, now, odds_a=0.5))
    assert not res.accepted
    assert ing.failures


def test_line_history_append_only_and_consensus():
    ev = uuid.uuid4()
    now = datetime(2026, 8, 1, tzinfo=UTC)
    ing = OddsIngestor(stale_seconds=100000)
    ing.ingest(_quote(ev, now - timedelta(minutes=10), line=-1.0, bookmaker="a"))
    ing.ingest(_quote(ev, now - timedelta(minutes=9), line=-2.0, bookmaker="b"))
    hist = ing.history(ev, MarketType.HANDICAP)
    assert len(hist) == 2
    assert hist.opening().line == -1.0
    assert ing.consensus_line(ev, MarketType.HANDICAP, now) == -1.5


def test_naive_datetime_rejected_at_quote_boundary():
    with pytest.raises(ValueError):
        _quote(uuid.uuid4(), datetime.now())  # naive published_at


# --- Chapter 8 ---------------------------------------------------------------


def test_signal_message_parses():
    ev = uuid.uuid4()
    msg = f"EVENT={ev} HA=-1.5 OA=1.91 OB=1.95 BOOK=pinnacle AT=2026-08-01T08:00:00+00:00"
    hc = parse_signal_message(msg)
    assert hc.event_id == ev and hc.handicap_a == -1.5
    q = to_quote(hc, source=OddsSource.SIGNAL_INGEST)
    assert q.market_type is MarketType.HANDICAP and q.line == -1.5


def test_signal_message_rejects_garbage():
    with pytest.raises(ValidationError):
        parse_signal_message("not a signal")


def test_handicap_create_validates_odds():
    with pytest.raises(Exception):
        HandicapCreate(
            event_id=uuid.uuid4(),
            handicap_a=-1.5,
            odds_a=0.5,  # invalid
            odds_b=1.9,
            bookmaker="b",
            published_at=datetime(2026, 8, 1, tzinfo=UTC),
        )


def test_ocr_without_gateway_raises_not_configured():
    with pytest.raises(NotConfigured):
        parse_handicap_image(None, b"\x89PNG...")


def test_ocr_with_mock_gateway():
    ev = uuid.uuid4()

    class MockGateway:
        def extract_json(self, image_bytes):
            return {
                "event_id": str(ev),
                "handicap_a": -1.5,
                "odds_a": 1.91,
                "odds_b": 1.95,
                "bookmaker": "boardcam",
                "published_at": "2026-08-01T08:00:00+00:00",
            }

    hc = parse_handicap_image(MockGateway(), b"img")
    store = InMemoryHandicapStore()
    store.persist_handicap(to_quote(hc, source=OddsSource.OCR))
    assert len(store.quotes) == 1


# --- OpticOdds adapter -------------------------------------------------------


def test_opticodds_config_requires_env():
    from handiedge.config import get_settings

    with pytest.raises(NotConfigured):
        OpticOddsConfig.from_settings(get_settings(opticodds_base_url=None))


def test_opticodds_adapter_with_mock_transport():
    ev = uuid.uuid4()

    class MockTransport:
        def get(self, path, params):
            return {
                "data": [
                    {
                        "event_id": str(ev),
                        "market": "point_spread",
                        "price_a": 1.91,
                        "price_b": 1.95,
                        "points": -1.5,
                        "sportsbook": "pinnacle",
                        "published_at": "2026-08-01T08:00:00+00:00",
                    }
                ]
            }

    adapter = OpticOddsAdapter(OpticOddsConfig("https://x", "key"), MockTransport())
    quotes = adapter.fetch_quotes(ev)
    assert len(quotes) == 1 and quotes[0].bookmaker == "pinnacle"


def test_opticodds_parse_rejects_unknown_market():
    with pytest.raises(ValidationError):
        parse_quote({"market": "asteroids", "event_id": str(uuid.uuid4())})
