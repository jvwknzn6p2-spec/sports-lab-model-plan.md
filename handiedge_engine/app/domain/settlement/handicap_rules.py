"""Handicap settlement rule registry.

Handicap rules live here as small strategy objects instead of being buried in
conditional blocks. Every rule reduces a handicap to one or more *legs*
``(line, weight)``; a leg settles like an integer line, and the weighted sum of
leg results yields the final outcome. This single mechanism expresses integer,
half, quarter, and the Japanese split notations — while keeping ``1半`` distinct
from the decimal ``1.5``.

Assumptions (documented; see README "Handicap limitations"):
  * ``1半``  (JP_HALF)  -> even split across integer lines {base, base+1}.
    This differs from decimal 1.5, which is a single non-push line. At a favorite
    margin of exactly base+1 the split yields a PARTIAL_WIN (half win) whereas
    1.5 would yield a full WIN — hence they must not be conflated.
  * ``1半n`` (JP_HALF_SUB) -> weighted split {base: (10-n)/10, base+1: n/10}.
"""

from __future__ import annotations

from decimal import Decimal

from app.core.enums import HandicapType, StrEnum
from app.domain.handicap.parser import (
    RULE_DECIMAL,
    RULE_INTEGER,
    RULE_JP_HALF,
    RULE_JP_HALF_SUB,
)
from app.schemas.handicap import Handicap


class HandicapOutcome(StrEnum):
    WIN = "WIN"
    PARTIAL_WIN = "PARTIAL_WIN"
    PUSH = "PUSH"
    PARTIAL_LOSS = "PARTIAL_LOSS"
    LOSS = "LOSS"


Leg = tuple[Decimal, Decimal]  # (line, weight); weights sum to 1


class HandicapResolutionError(ValueError):
    """Raised when a handicap cannot be reduced to legs (unresolved notation)."""


def _integer_legs(h: Handicap) -> list[Leg]:
    assert h.handicap_value is not None
    return [(h.handicap_value, Decimal("1"))]


def _decimal_legs(h: Handicap) -> list[Leg]:
    assert h.handicap_value is not None
    value = h.handicap_value
    frac = (value - int(value)).copy_abs()
    if frac == Decimal("0") or frac == Decimal("0.5"):
        # Whole or half line -> single leg (half lines never push).
        return [(value, Decimal("1"))]
    if frac == Decimal("0.25") or frac == Decimal("0.75"):
        low = (value - Decimal("0.25"))
        high = (value + Decimal("0.25"))
        return [(low, Decimal("0.5")), (high, Decimal("0.5"))]
    raise HandicapResolutionError(f"unsupported decimal handicap fraction: {value}")


def _jp_half_legs(h: Handicap) -> list[Leg]:
    base = _jp_base(h)
    return [(Decimal(base), Decimal("0.5")), (Decimal(base + 1), Decimal("0.5"))]


def _jp_half_sub_legs(h: Handicap) -> list[Leg]:
    base = _jp_base(h)
    n = h.handicap_sub_number
    if n is None:
        raise HandicapResolutionError("JP_HALF_SUB missing sub number")
    w_low = Decimal(10 - n) / Decimal(10)
    w_high = Decimal(n) / Decimal(10)
    return [(Decimal(base), w_low), (Decimal(base + 1), w_high)]


def _jp_base(h: Handicap) -> int:
    # Recover the integer base from the display, e.g. "1半" / "1半3" -> 1.
    digits = ""
    for ch in h.handicap_display:
        if ch.isdigit():
            digits += ch
        else:
            break
    if not digits:
        raise HandicapResolutionError(f"cannot recover base from {h.handicap_display!r}")
    return int(digits)


# rule identifier -> leg factory
_LEG_FACTORIES = {
    RULE_INTEGER: _integer_legs,
    RULE_DECIMAL: _decimal_legs,
    RULE_JP_HALF: _jp_half_legs,
    RULE_JP_HALF_SUB: _jp_half_sub_legs,
}


def resolve_legs(handicap: Handicap) -> list[Leg]:
    if handicap.handicap_type is HandicapType.UNRESOLVED or not handicap.is_resolved:
        raise HandicapResolutionError("handicap is UNRESOLVED")
    factory = _LEG_FACTORIES.get(handicap.handicap_settlement_rule)
    if factory is None:
        raise HandicapResolutionError(
            f"no settlement rule for {handicap.handicap_settlement_rule}"
        )
    return factory(handicap)


def settle_favorite_margin(handicap: Handicap, favorite_margin: int) -> HandicapOutcome:
    """Settle the *favorite* side of ``handicap`` given the favorite's margin.

    ``favorite_margin`` = favorite_score - underdog_score (may be negative).
    The favorite *gives* the handicap points, so a leg wins when
    ``favorite_margin - line > 0``.
    """

    legs = resolve_legs(handicap)
    score = Decimal("0")
    for line, weight in legs:
        adj = Decimal(favorite_margin) - line
        if adj > 0:
            leg_result = Decimal("1")
        elif adj < 0:
            leg_result = Decimal("-1")
        else:
            leg_result = Decimal("0")
        score += weight * leg_result

    if score == Decimal("1"):
        return HandicapOutcome.WIN
    if score == Decimal("-1"):
        return HandicapOutcome.LOSS
    if score == Decimal("0"):
        return HandicapOutcome.PUSH
    return HandicapOutcome.PARTIAL_WIN if score > 0 else HandicapOutcome.PARTIAL_LOSS
