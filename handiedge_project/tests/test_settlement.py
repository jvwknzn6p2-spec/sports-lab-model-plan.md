"""Settlement rule tests (audit category 1)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from handiedge.domain.events import EventOutcome
from handiedge.domain.settlement import pnl, settle
from handiedge.domain.taxonomy import MarketType, SettlementResult, Side


def _outcome(h, a, voided=False):
    return EventOutcome(
        event_id=uuid.uuid4(),
        score_home=h,
        score_away=a,
        voided=voided,
        settled_at=datetime.now(UTC),
    )


def test_handicap_cover_win():
    s = settle(_outcome(3, 0), MarketType.HANDICAP, Side.A, line=-1.5)
    assert s.result is SettlementResult.WIN


def test_handicap_exact_push():
    # A -1.0, home wins by exactly 1 -> push (stake returned).
    s = settle(_outcome(1, 0), MarketType.HANDICAP, Side.A, line=-1.0)
    assert s.result is SettlementResult.PUSH
    assert pnl(s, 100, 1.91) == 0.0


def test_quarter_line_half_win():
    # A -0.75, home wins by exactly 1 -> half win (-0.5 pushes, -1.0 wins).
    s = settle(_outcome(1, 0), MarketType.HANDICAP, Side.A, line=-0.75)
    assert s.result is SettlementResult.HALF_WIN
    # profit on half stake at 2.0 odds
    assert pnl(s, 100, 2.0) == pytest.approx(50.0)


def test_quarter_line_half_lose():
    # A +0.25, home loses by exactly ... margin_a=0 (draw): +0.0 push, +0.5 win?
    # Use A -0.25, draw (0-0): -0.0 push + -0.5 lose => half lose.
    s = settle(_outcome(0, 0), MarketType.HANDICAP, Side.A, line=-0.25)
    assert s.result is SettlementResult.HALF_LOSE
    assert pnl(s, 100, 2.0) == pytest.approx(-50.0)


def test_total_over_under_and_push():
    assert (
        settle(_outcome(3, 2), MarketType.TOTAL, Side.OVER, line=4.5).result is SettlementResult.WIN
    )
    assert (
        settle(_outcome(1, 1), MarketType.TOTAL, Side.UNDER, line=2.5).result
        is SettlementResult.WIN
    )
    assert (
        settle(_outcome(2, 3), MarketType.TOTAL, Side.OVER, line=5.0).result
        is SettlementResult.PUSH
    )


def test_moneyline_two_way_tie_is_push():
    s = settle(_outcome(1, 1), MarketType.MONEYLINE, Side.A, draw_allowed=False)
    assert s.result is SettlementResult.PUSH


def test_moneyline_three_way_draw():
    s = settle(_outcome(1, 1), MarketType.MONEYLINE, Side.DRAW, draw_allowed=True)
    assert s.result is SettlementResult.WIN


def test_void_returns_stake():
    s = settle(_outcome(5, 0, voided=True), MarketType.HANDICAP, Side.A, line=-1.5)
    assert s.result is SettlementResult.VOID
    assert pnl(s, 100, 1.91) == 0.0


def test_lose_pnl_is_negative_stake():
    s = settle(_outcome(0, 3), MarketType.HANDICAP, Side.A, line=-1.5)
    assert s.result is SettlementResult.LOSE
    assert pnl(s, 100, 1.91) == -100.0


def test_pnl_rejects_bad_odds():
    s = settle(_outcome(3, 0), MarketType.HANDICAP, Side.A, line=-1.5)
    with pytest.raises(ValueError):
        pnl(s, 100, 1.0)
