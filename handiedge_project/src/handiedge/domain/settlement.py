"""Settlement rules per market type (audit category 1).

Each market type has explicit, testable logic that maps a final outcome to a
:class:`SettlementResult` for a picked selection. Push / void / quarter-line
half-win/half-lose are first-class results — never silently scored as a loss or
dropped (which would inflate hit rate).

A settled result also carries a *stake multiplier* so P&L is computed correctly
including partial (quarter-line) settlement and stake return on push/void.
"""

from __future__ import annotations

from dataclasses import dataclass

from .events import EventOutcome
from .taxonomy import MarketType, SettlementResult, Side


@dataclass(frozen=True, slots=True)
class Settled:
    result: SettlementResult
    # Fraction of stake that is "at risk" on the win/lose portion (the rest pushes).
    # 1.0 = full action; 0.5 = quarter-line split; 0.0 = full push/void.
    win_fraction: float


def _handicap_result(margin_a: float, line: float, side: Side) -> Settled:
    """Settle an Asian-handicap bet.

    ``margin_a`` = score_home - score_away. ``line`` is the handicap applied to
    side A (e.g. -1.5 means A must win by 2+). Quarter lines (…, -0.25, -0.75)
    split the stake across the two neighbouring half-lines.
    """
    # Quarter line: split into two half-stakes on the adjacent .0/.5 lines.
    if abs((line * 4) % 2) == 1:  # x.25 or x.75
        lo = line - 0.25
        hi = line + 0.25
        s_lo = _handicap_result(margin_a, lo, side)
        s_hi = _handicap_result(margin_a, hi, side)
        return _combine_quarter(s_lo, s_hi)

    adj = margin_a + line if side is Side.A else -margin_a - line
    if adj > 0:
        return Settled(SettlementResult.WIN, 1.0)
    if adj < 0:
        return Settled(SettlementResult.LOSE, 1.0)
    return Settled(SettlementResult.PUSH, 0.0)


def _combine_quarter(a: Settled, b: Settled) -> Settled:
    """Combine two half-stake legs of a quarter-line bet into one result."""
    order = {
        SettlementResult.LOSE: 0,
        SettlementResult.PUSH: 1,
        SettlementResult.WIN: 2,
    }
    la, lb = order[a.result], order[b.result]
    if la == lb == 2:
        return Settled(SettlementResult.WIN, 1.0)
    if la == lb == 0:
        return Settled(SettlementResult.LOSE, 1.0)
    if {la, lb} == {2, 1}:  # win + push
        return Settled(SettlementResult.HALF_WIN, 0.5)
    if {la, lb} == {0, 1}:  # lose + push
        return Settled(SettlementResult.HALF_LOSE, 0.5)
    # win + lose can't happen for adjacent half-lines; treat as push defensively.
    return Settled(SettlementResult.PUSH, 0.0)


def _total_result(total_points: int, line: float, side: Side) -> Settled:
    if side not in (Side.OVER, Side.UNDER):
        raise ValueError("total market requires OVER/UNDER side")
    if total_points > line:
        winner = Side.OVER
    elif total_points < line:
        winner = Side.UNDER
    else:
        return Settled(SettlementResult.PUSH, 0.0)
    return Settled(SettlementResult.WIN if side is winner else SettlementResult.LOSE, 1.0)


def _moneyline_result(margin_a: float, side: Side, *, draw_allowed: bool) -> Settled:
    if margin_a > 0:
        winner = Side.A
    elif margin_a < 0:
        winner = Side.B
    else:
        if draw_allowed:
            winner = Side.DRAW
        else:
            # two-way moneyline with a tie => push (stake returned)
            return Settled(SettlementResult.PUSH, 0.0)
    return Settled(SettlementResult.WIN if side is winner else SettlementResult.LOSE, 1.0)


def settle(
    outcome: EventOutcome,
    market_type: MarketType,
    side: Side,
    *,
    line: float | None = None,
    draw_allowed: bool = False,
) -> Settled:
    """Settle a single pick against a final outcome."""
    if outcome.voided:
        return Settled(SettlementResult.VOID, 0.0)

    margin_a = float(outcome.score_home - outcome.score_away)
    total_points = outcome.score_home + outcome.score_away

    if market_type is MarketType.HANDICAP:
        if line is None:
            raise ValueError("handicap market requires a line")
        return _handicap_result(margin_a, line, side)
    if market_type is MarketType.TOTAL:
        if line is None:
            raise ValueError("total market requires a line")
        return _total_result(total_points, line, side)
    if market_type is MarketType.MONEYLINE:
        return _moneyline_result(margin_a, side, draw_allowed=draw_allowed)
    raise ValueError(f"unknown market {market_type!r}")


def pnl(settled: Settled, stake: float, decimal_odds: float) -> float:
    """Net profit/loss for a settled bet at given decimal odds.

    Convention: ``decimal_odds`` is the gross return multiple on the winning
    portion (2.0 = even money). Push/void return the pushed stake (0 P&L on that
    portion). Half results split stake 50/50 between the action and pushed legs.
    """
    if decimal_odds <= 1.0:
        raise ValueError("decimal_odds must be > 1.0")
    profit_per_unit = decimal_odds - 1.0
    r = settled.result
    if r in (SettlementResult.PUSH, SettlementResult.VOID):
        return 0.0
    if r is SettlementResult.WIN:
        return stake * profit_per_unit
    if r is SettlementResult.LOSE:
        return -stake
    if r is SettlementResult.HALF_WIN:
        return (stake * 0.5) * profit_per_unit  # other half pushes -> 0
    if r is SettlementResult.HALF_LOSE:
        return -(stake * 0.5)
    raise ValueError(f"unhandled result {r!r}")
