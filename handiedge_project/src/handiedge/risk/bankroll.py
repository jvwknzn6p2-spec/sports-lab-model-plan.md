"""Bankroll and risk controls (audit category 10).

Enforced-in-code controls:
- fractional-Kelly stake sizing (never full Kelly), with a hard per-bet cap;
- max exposure per bet, per event, per market, and per source/bookmaker;
- drawdown stop: halt staking once bankroll falls a configured fraction below peak;
- explicit NO chase-loss / martingale logic (skill HARD RULE).

Correlated exposure is addressed by capping *aggregate* stake on the same event
across markets, so multiple bets that amplify a single outcome cannot exceed a
combined limit.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from ..errors import ChaseLossError


def kelly_fraction(prob: float, decimal_odds: float) -> float:
    """Full-Kelly fraction for a single outcome. Returns 0 if there's no edge.

    f* = (b*p - q) / b, where b = decimal_odds - 1, q = 1 - p. Clamped at 0 (no
    negative/again-the-edge staking).
    """
    b = decimal_odds - 1.0
    if b <= 0:
        return 0.0
    q = 1.0 - prob
    f = (b * prob - q) / b
    return max(0.0, f)


@dataclass(frozen=True, slots=True)
class RiskPolicy:
    kelly_multiplier: float = 0.25  # fractional Kelly (quarter-Kelly default)
    max_fraction_per_bet: float = 0.02  # hard cap: <=2% of bankroll on one bet
    max_fraction_per_event: float = 0.04  # aggregate across markets on one event
    max_fraction_per_market: float = 0.03
    max_fraction_per_source: float = 0.10
    drawdown_stop: float = 0.20  # halt when bankroll <= (1 - 0.20) * peak

    def __post_init__(self) -> None:
        if not 0 < self.kelly_multiplier <= 1:
            raise ValueError("kelly_multiplier must be in (0, 1]")
        for name in (
            "max_fraction_per_bet",
            "max_fraction_per_event",
            "max_fraction_per_market",
            "max_fraction_per_source",
        ):
            v = getattr(self, name)
            if not 0 < v <= 1:
                raise ValueError(f"{name} must be in (0, 1]")


@dataclass(slots=True)
class StakeDecision:
    stake: float
    fraction: float
    capped_by: str | None  # which limit bound the stake, if any
    blocked: bool = False
    reason: str | None = None


@dataclass(slots=True)
class BankrollManager:
    """Stateful bankroll with peak tracking and exposure ledgers per period."""

    bankroll: float
    policy: RiskPolicy = field(default_factory=RiskPolicy)
    _peak: float = field(init=False, default=0.0)
    _event_exposure: dict[uuid.UUID, float] = field(init=False, default_factory=dict)
    _market_exposure: dict[tuple[uuid.UUID, str], float] = field(init=False, default_factory=dict)
    _source_exposure: dict[str, float] = field(init=False, default_factory=dict)

    def __post_init__(self) -> None:
        if self.bankroll <= 0:
            raise ValueError("bankroll must be positive")
        self._peak = self.bankroll

    @property
    def stopped(self) -> bool:
        """True if drawdown stop is triggered — staking must halt."""
        return self.bankroll <= (1.0 - self.policy.drawdown_stop) * self._peak

    def _remaining(self, used: float, cap_fraction: float) -> float:
        return max(0.0, cap_fraction * self.bankroll - used)

    def size_bet(
        self,
        *,
        prob: float,
        decimal_odds: float,
        event_id: uuid.UUID,
        market: str,
        source: str,
    ) -> StakeDecision:
        """Size a bet under fractional Kelly and all exposure caps."""
        if self.stopped:
            return StakeDecision(0.0, 0.0, None, blocked=True, reason="drawdown_stop")

        f_full = kelly_fraction(prob, decimal_odds)
        if f_full <= 0:
            return StakeDecision(0.0, 0.0, None, blocked=True, reason="no_edge")

        frac = f_full * self.policy.kelly_multiplier
        stake = frac * self.bankroll
        capped_by: str | None = None

        per_bet = self.policy.max_fraction_per_bet * self.bankroll
        if stake > per_bet:
            stake, capped_by = per_bet, "per_bet"

        caps = [
            (
                "per_event",
                self._remaining(
                    self._event_exposure.get(event_id, 0.0), self.policy.max_fraction_per_event
                ),
            ),
            (
                "per_market",
                self._remaining(
                    self._market_exposure.get((event_id, market), 0.0),
                    self.policy.max_fraction_per_market,
                ),
            ),
            (
                "per_source",
                self._remaining(
                    self._source_exposure.get(source, 0.0), self.policy.max_fraction_per_source
                ),
            ),
        ]
        for name, remaining in caps:
            if stake > remaining:
                stake, capped_by = remaining, name

        if stake <= 0:
            return StakeDecision(0.0, 0.0, capped_by, blocked=True, reason="exposure_limit")
        return StakeDecision(stake, stake / self.bankroll, capped_by)

    def commit(
        self, decision: StakeDecision, *, event_id: uuid.UUID, market: str, source: str
    ) -> None:
        """Record committed exposure for an accepted bet (does not settle yet)."""
        if decision.blocked or decision.stake <= 0:
            return
        self._event_exposure[event_id] = self._event_exposure.get(event_id, 0.0) + decision.stake
        key = (event_id, market)
        self._market_exposure[key] = self._market_exposure.get(key, 0.0) + decision.stake
        self._source_exposure[source] = self._source_exposure.get(source, 0.0) + decision.stake

    def settle(self, net_return: float) -> None:
        """Apply a settled bet's net P&L to the bankroll and update the peak."""
        self.bankroll += net_return
        self._peak = max(self._peak, self.bankroll)

    def next_stake_must_not_chase(
        self, proposed_stake: float, prior_stake: float, after_loss: bool
    ) -> None:
        """Guard: reject any attempt to raise stake specifically after a loss.

        This exists so chase-loss logic cannot be introduced silently. Sizing is a
        pure function of edge/odds/bankroll — never of prior results.
        """
        if after_loss and proposed_stake > prior_stake:
            raise ChaseLossError(
                "stake increased following a loss — chase-loss/martingale is forbidden"
            )
