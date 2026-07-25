"""Backtest realism tests (audit category 8)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from handiedge.backtest.engine import BacktestEngine, ExecutionModel, Signal
from handiedge.domain.events import EventOutcome
from handiedge.domain.taxonomy import MarketType, Side
from handiedge.odds.ingestion import OddsIngestor
from handiedge.odds.models import OddsQuote, OddsSource
from handiedge.risk.bankroll import BankrollManager, RiskPolicy


def _ingestor_with_quote(event_id, pub, line=-1.5, oa=2.0, ob=1.9, stale=3600):
    ing = OddsIngestor(stale_seconds=stale)
    ing.ingest(
        OddsQuote(
            quote_id=uuid.uuid4(),
            event_id=event_id,
            market_type=MarketType.HANDICAP,
            source=OddsSource.API,
            bookmaker="bookA",
            published_at=pub,
            ingested_at=pub,
            odds_a=oa,
            odds_b=ob,
            line=line,
        )
    )
    return ing


def test_stale_signal_is_skipped():
    ev = uuid.uuid4()
    sched = datetime(2026, 8, 1, tzinfo=UTC)
    pub = sched - timedelta(hours=5)  # very old
    ing = _ingestor_with_quote(ev, pub, stale=300)
    bm = BankrollManager(1000.0)
    engine = BacktestEngine(ing, bm, ExecutionModel(latency=timedelta(seconds=30)))
    sig = Signal(ev, MarketType.HANDICAP, Side.A, prob=0.7, signal_at=sched)
    res = engine.run([sig], {ev: EventOutcome(ev, 3, 0)}, {ev: -1.5})
    assert res.skipped_stale == 1
    assert not res.placed


def test_slippage_worsens_executed_odds():
    ev = uuid.uuid4()
    sig_at = datetime(2026, 8, 1, tzinfo=UTC)
    ing = _ingestor_with_quote(ev, sig_at - timedelta(seconds=10), oa=2.0)
    bm = BankrollManager(1000.0, RiskPolicy(max_fraction_per_bet=0.1))
    engine = BacktestEngine(
        ing, bm, ExecutionModel(latency=timedelta(seconds=5), slippage_odds=0.1)
    )
    sig = Signal(ev, MarketType.HANDICAP, Side.A, prob=0.7, signal_at=sig_at)
    res = engine.run([sig], {ev: EventOutcome(ev, 3, 0)}, {ev: -1.5})
    assert res.placed
    assert res.placed[0].decimal_odds < 2.0  # slippage applied


def test_push_scored_as_zero_not_loss():
    ev = uuid.uuid4()
    sig_at = datetime(2026, 8, 1, tzinfo=UTC)
    ing = _ingestor_with_quote(ev, sig_at - timedelta(seconds=10), line=-1.0, oa=2.0)
    bm = BankrollManager(1000.0, RiskPolicy(max_fraction_per_bet=0.1))
    engine = BacktestEngine(ing, bm, ExecutionModel(latency=timedelta(seconds=5)))
    sig = Signal(ev, MarketType.HANDICAP, Side.A, prob=0.7, signal_at=sig_at)
    # Home wins by exactly 1 with line -1.0 => push.
    res = engine.run([sig], {ev: EventOutcome(ev, 1, 0)}, {ev: -1.0})
    assert res.placed[0].result == "push"
    assert res.placed[0].net_return == 0.0


def test_all_bets_rejected():
    ev = uuid.uuid4()
    sig_at = datetime(2026, 8, 1, tzinfo=UTC)
    ing = _ingestor_with_quote(ev, sig_at - timedelta(seconds=10))
    bm = BankrollManager(1000.0, RiskPolicy(max_fraction_per_bet=0.1))
    engine = BacktestEngine(ing, bm, ExecutionModel(latency=timedelta(seconds=5), reject_prob=1.0))
    sig = Signal(ev, MarketType.HANDICAP, Side.A, prob=0.7, signal_at=sig_at)
    res = engine.run([sig], {ev: EventOutcome(ev, 3, 0)}, {ev: -1.5})
    assert res.rejected == 1
    assert not res.placed
