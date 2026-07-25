"""Normalization tests: MLB/NPB fixtures, empty odds, null NPB fields, epochs."""

from __future__ import annotations

import json
from datetime import UTC
from pathlib import Path

import pytest

from handiedge.connector.normalize import (
    normalize_fixture,
    normalize_odds_fixture,
    normalize_result,
)
from handiedge.errors import ValidationError

FIX = Path(__file__).parent / "fixtures"


def _first_fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text())["data"]["data"][0]


def test_mlb_fixture_preserves_canonical_ids_and_utc():
    raw = _first_fixture("mlb_fixtures_active.json")
    fx = normalize_fixture(raw, league="mlb")
    assert fx.fixture_id == "mlb-fixture-0001"
    assert fx.game_id == "mlb-game-0001"
    assert fx.home.team_id == "mlb-team-nyy"
    assert fx.away.team_id == "mlb-team-bos"
    assert fx.start_time.tzinfo == UTC
    assert fx.home.starter_name == "Ace Alpha"


def test_npb_null_fields_tolerated():
    raw = _first_fixture("npb_fixture_null_fields.json")
    fx = normalize_fixture(raw, league="npb")
    # Null starter / record / venue must not crash and must stay None.
    assert fx.home.record is None
    assert fx.home.starter_id is None
    assert fx.home.starter_name is None
    assert fx.venue is None
    assert fx.game_id is None
    # Tokyo local start persists as UTC internally.
    assert fx.start_time.tzinfo == UTC
    assert fx.start_time.hour == 0  # 09:00 JST == 00:00 UTC


def test_empty_odds_returns_empty_list_not_error():
    raw = _first_fixture("mlb_odds_empty.json")
    rows = normalize_odds_fixture(raw, league="mlb")
    assert rows == []


def test_npb_odds_flatten_and_epoch_to_utc():
    raw = _first_fixture("npb_odds.json")
    rows = normalize_odds_fixture(raw, league="npb")
    assert len(rows) == 6
    assert any(r.market_id == "moneyline" for r in rows)
    assert all(r.league == "npb" for r in rows)
    assert all(r.published_at.tzinfo == UTC for r in rows)
    tot = [r for r in rows if r.market_id == "total_runs"]
    assert {r.points for r in tot} == {7.5}


def test_odds_reject_nondecimal_price():
    raw = {"id": "f1", "odds": [{"market_id": "moneyline", "price": 0.9}]}
    with pytest.raises(ValidationError):
        normalize_odds_fixture(raw, league="mlb")


def test_odds_reject_american_negative_price_not_decimal():
    # Regression for the live-smoke finding: an American price like -172 must NOT be
    # silently accepted as a decimal price. The normalizer stays strict (> 1.0) and
    # rejects it; DECIMAL is enforced at the request boundary instead.
    raw = {"id": "f1", "odds": [{"market_id": "moneyline", "price": -172.0, "team_id": "t1"}]}
    with pytest.raises(ValidationError, match="> 1.0"):
        normalize_odds_fixture(raw, league="npb")


def test_result_status_maps_final_and_void():
    final = normalize_result(
        {"id": "f1", "status": "completed", "scores": {"home_score": 5, "away_score": 3}},
        league="mlb",
    )
    assert final.is_final and not final.voided
    assert final.home_score == 5 and final.away_score == 3
    void = normalize_result({"id": "f2", "status": "cancelled"}, league="mlb")
    assert void.voided and not void.is_final


def test_epoch_milliseconds_detected():
    raw = {
        "id": "f1",
        "odds": [
            {"market_id": "moneyline", "price": 1.9, "timestamp": 1775000000000, "team_id": "t1"}
        ],
    }
    rows = normalize_odds_fixture(raw, league="mlb")
    assert rows[0].published_at.year == 2026
