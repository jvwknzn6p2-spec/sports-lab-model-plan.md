"""Canonical sport / league / market / selection taxonomy.

Enums are *closed* — arbitrary strings cannot enter the system (audit category 1).
Market types are modelled distinctly so settlement logic can differ per type rather
than overloading a single generic ``result`` column.
"""

from __future__ import annotations

from enum import Enum


class Sport(str, Enum):
    NPB = "NPB"
    MLB = "MLB"
    SOCCER = "SOCCER"


# League codes are league-specific and validated against the sport they belong to.
LEAGUES_BY_SPORT: dict[Sport, frozenset[str]] = {
    Sport.NPB: frozenset({"NPB-CENTRAL", "NPB-PACIFIC"}),
    Sport.MLB: frozenset({"MLB-AL", "MLB-NL"}),
    Sport.SOCCER: frozenset({"JLEAGUE-1", "EPL", "LALIGA"}),
}


class MarketType(str, Enum):
    """Distinct market types with distinct settlement semantics."""

    HANDICAP = "HANDICAP"  # Asian handicap / spread on team A
    MONEYLINE = "MONEYLINE"  # win/lose (two-way, or three-way when draw allowed)
    TOTAL = "TOTAL"  # over/under a points line


class Side(str, Enum):
    A = "A"  # home / first-listed selection
    B = "B"  # away / second-listed selection
    OVER = "OVER"
    UNDER = "UNDER"
    DRAW = "DRAW"


class SettlementResult(str, Enum):
    WIN = "win"
    LOSE = "lose"
    PUSH = "push"  # stake returned (exact handicap/total hit)
    HALF_WIN = "half_win"  # quarter-line: half stake wins, half pushes
    HALF_LOSE = "half_lose"
    VOID = "void"  # cancelled / no-action


def is_valid_league(sport: Sport, league: str) -> bool:
    return league in LEAGUES_BY_SPORT.get(sport, frozenset())


def sides_for_market(market: MarketType, *, draw_allowed: bool = False) -> tuple[Side, ...]:
    """Return the valid selections for a market type."""
    if market is MarketType.HANDICAP:
        return (Side.A, Side.B)
    if market is MarketType.TOTAL:
        return (Side.OVER, Side.UNDER)
    if market is MarketType.MONEYLINE:
        return (Side.A, Side.DRAW, Side.B) if draw_allowed else (Side.A, Side.B)
    raise ValueError(f"unknown market {market!r}")
