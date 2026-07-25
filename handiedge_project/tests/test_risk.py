"""Bankroll / risk control tests (audit category 10)."""

from __future__ import annotations

import uuid

import pytest

from handiedge.errors import ChaseLossError
from handiedge.risk.bankroll import BankrollManager, RiskPolicy, kelly_fraction


def test_kelly_zero_without_edge():
    # Fair coin at even money -> no edge -> 0.
    assert kelly_fraction(0.5, 2.0) == 0.0
    assert kelly_fraction(0.6, 2.0) > 0.0


def test_fractional_kelly_and_per_bet_cap():
    bm = BankrollManager(1000.0, RiskPolicy(kelly_multiplier=0.25, max_fraction_per_bet=0.02))
    d = bm.size_bet(
        prob=0.9, decimal_odds=2.0, event_id=uuid.uuid4(), market="HANDICAP", source="bookA"
    )
    # Even huge edge is capped at 2% of bankroll.
    assert d.stake <= 20.0 + 1e-9
    assert d.capped_by == "per_bet"


def test_event_exposure_cap_across_markets():
    ev = uuid.uuid4()
    bm = BankrollManager(
        1000.0,
        RiskPolicy(kelly_multiplier=1.0, max_fraction_per_bet=0.05, max_fraction_per_event=0.04),
    )
    d1 = bm.size_bet(prob=0.9, decimal_odds=2.0, event_id=ev, market="HANDICAP", source="b")
    bm.commit(d1, event_id=ev, market="HANDICAP", source="b")
    d2 = bm.size_bet(prob=0.9, decimal_odds=2.0, event_id=ev, market="TOTAL", source="b")
    # Combined stake cannot exceed 4% of bankroll (correlated exposure control).
    assert d1.stake + d2.stake <= 40.0 + 1e-6


def test_drawdown_stop_blocks_new_bets():
    bm = BankrollManager(1000.0, RiskPolicy(drawdown_stop=0.2))
    bm.settle(-250.0)  # 25% drawdown from peak
    assert bm.stopped
    d = bm.size_bet(
        prob=0.9, decimal_odds=2.0, event_id=uuid.uuid4(), market="HANDICAP", source="b"
    )
    assert d.blocked and d.reason == "drawdown_stop"


def test_no_chase_loss():
    bm = BankrollManager(1000.0)
    with pytest.raises(ChaseLossError):
        bm.next_stake_must_not_chase(proposed_stake=50, prior_stake=25, after_loss=True)
    # Same size after a loss is fine.
    bm.next_stake_must_not_chase(proposed_stake=25, prior_stake=25, after_loss=True)
