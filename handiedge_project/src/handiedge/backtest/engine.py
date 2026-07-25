"""Realistic walk-forward backtest engine (audit category 8).

Models the frictions that separate a paper edge from a real one:
- odds available *at bet time* only (uses the line published at/ before the signal
  time, subject to the stale policy — never the closing line);
- execution latency between signal and placement, during which the line can move;
- slippage: the executed odds may be worse than the decision-time odds;
- bet rejection (bookmaker declines) and stake limits;
- push/void/partial (quarter-line) settlement via the settlement module;
- correlated exposure via the shared :class:`BankrollManager` per-event caps;
- walk-forward: each bet is settled only from the event's own final outcome.

It produces a per-bet ledger and an equity path; profitability metrics are then
computed by :mod:`handiedge.evaluation.metrics`. The engine fabricates nothing —
it consumes explicit inputs the caller supplies.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ..domain.events import EventOutcome
from ..domain.settlement import pnl, settle
from ..domain.taxonomy import MarketType, Side
from ..errors import StaleDataError
from ..odds.ingestion import OddsIngestor
from ..risk.bankroll import BankrollManager


@dataclass(frozen=True, slots=True)
class Signal:
    """A model's intent to bet, generated at ``signal_at``."""

    event_id: uuid.UUID
    market_type: MarketType
    side: Side
    prob: float  # model fair probability for the picked side
    signal_at: datetime


@dataclass(frozen=True, slots=True)
class ExecutionModel:
    """Latency / slippage / rejection assumptions (explicit, not hidden)."""

    latency: timedelta = timedelta(seconds=30)
    slippage_odds: float = 0.0  # decimal-odds worsening applied at execution
    reject_prob: float = 0.0  # fraction of bets the book declines
    max_stake: float | None = None  # bookmaker max stake cap


@dataclass(slots=True)
class BetRecord:
    event_id: uuid.UUID
    side: Side
    stake: float
    decimal_odds: float
    result: str
    net_return: float
    rejected: bool = False
    reason: str | None = None


@dataclass(slots=True)
class BacktestResult:
    bets: list[BetRecord] = field(default_factory=list)
    equity: list[float] = field(default_factory=list)
    rejected: int = 0
    skipped_stale: int = 0
    abstained: int = 0

    @property
    def placed(self) -> list[BetRecord]:
        return [b for b in self.bets if not b.rejected]


class BacktestEngine:
    def __init__(
        self,
        ingestor: OddsIngestor,
        bankroll: BankrollManager,
        execution: ExecutionModel,
        *,
        seed: int = 20260723,
    ) -> None:
        self._ingestor = ingestor
        self._bankroll = bankroll
        self._exec = execution
        import numpy as np

        self._rng = np.random.default_rng(seed)

    def _executed_odds(self, side: Side, quote_odds_a: float, quote_odds_b: float) -> float:
        base = quote_odds_a if side in (Side.A, Side.OVER) else quote_odds_b
        # Slippage worsens the odds (lower decimal payout).
        return max(1.0001, base - self._exec.slippage_odds)

    def run(
        self,
        signals: list[Signal],
        outcomes: dict[uuid.UUID, EventOutcome],
        lines: dict[uuid.UUID, float],
    ) -> BacktestResult:
        """Run the backtest.

        ``outcomes`` maps event_id -> final outcome; ``lines`` maps event_id ->
        the handicap/total line that was in force for settlement.
        """
        result = BacktestResult(equity=[self._bankroll.bankroll])
        for sig in sorted(signals, key=lambda s: s.signal_at):
            place_at = sig.signal_at + self._exec.latency
            # Odds available at execution time, subject to stale policy.
            try:
                quote = self._ingestor.quote_for_decision(sig.event_id, sig.market_type, place_at)
            except StaleDataError:
                result.skipped_stale += 1
                continue

            decimal_odds = self._executed_odds(sig.side, quote.odds_a, quote.odds_b)

            decision = self._bankroll.size_bet(
                prob=sig.prob,
                decimal_odds=decimal_odds,
                event_id=sig.event_id,
                market=sig.market_type.value,
                source=quote.bookmaker,
            )
            if decision.blocked:
                result.abstained += 1
                continue

            stake = decision.stake
            if self._exec.max_stake is not None:
                stake = min(stake, self._exec.max_stake)

            # Bookmaker rejection.
            if self._exec.reject_prob > 0 and self._rng.random() < self._exec.reject_prob:
                result.rejected += 1
                result.bets.append(
                    BetRecord(
                        sig.event_id,
                        sig.side,
                        0.0,
                        decimal_odds,
                        "rejected",
                        0.0,
                        rejected=True,
                        reason="bookmaker_reject",
                    )
                )
                continue

            self._bankroll.commit(
                decision,
                event_id=sig.event_id,
                market=sig.market_type.value,
                source=quote.bookmaker,
            )

            outcome = outcomes[sig.event_id]
            settled = settle(
                outcome,
                sig.market_type,
                sig.side,
                line=lines.get(sig.event_id, quote.line),
            )
            net = pnl(settled, stake, decimal_odds)
            self._bankroll.settle(net)
            result.bets.append(
                BetRecord(sig.event_id, sig.side, stake, decimal_odds, settled.result.value, net)
            )
            result.equity.append(self._bankroll.bankroll)
        return result
