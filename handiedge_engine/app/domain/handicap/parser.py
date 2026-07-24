"""Handicap parser — a dedicated bounded context.

Supported notations:
  * ``0``            -> INTEGER
  * ``0.x``          -> DECIMAL (e.g. 0.5, 0.25)
  * ``1.0``          -> DECIMAL / INTEGER-valued
  * ``1.x``          -> DECIMAL
  * ``1半``          -> JP_HALF  (Japanese "half"; **NOT** normalized to 1.5)
  * ``1半1`` .. ``1半9`` -> JP_HALF_SUB (half with a sub-number 1..9)

Anything else -> UNRESOLVED. We never guess a value for unsupported notation.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from app.core.enums import HandicapRuleStatus, HandicapType
from app.schemas.handicap import Handicap

# Japanese full-width digits mapped to ASCII so "１半３" parses like "1半3".
_JP_DIGIT_MAP = str.maketrans("０１２３４５６７８９", "0123456789")

_HALF_CHAR = "半"

_INTEGER_RE = re.compile(r"^[+-]?\d+$")
_DECIMAL_RE = re.compile(r"^[+-]?\d+\.\d+$")
# e.g. "1半", "1半3", "12半", allowing an optional single sub-digit 1..9
_JP_HALF_RE = re.compile(rf"^(\d+){_HALF_CHAR}([1-9])?$")

# Settlement rule identifiers (resolved by the settlement strategy registry).
RULE_INTEGER = "HDP_INTEGER_V1"
RULE_DECIMAL = "HDP_DECIMAL_V1"
RULE_JP_HALF = "HDP_JP_HALF_V1"
RULE_JP_HALF_SUB = "HDP_JP_HALF_SUB_V1"
RULE_UNRESOLVED = "HDP_UNRESOLVED"


def parse_handicap(
    raw: str | None,
    *,
    favorite: str | None = None,
    receiver: str | None = None,
) -> Handicap:
    """Parse a handicap source string into a typed :class:`Handicap`.

    Never raises for unsupported input; instead returns an UNRESOLVED handicap so
    that the normal-win prediction can proceed while the handicap lock is blocked.
    """

    if raw is None:
        return _unresolved("", favorite, receiver, "handicap source missing")

    original = raw
    text = raw.strip().translate(_JP_DIGIT_MAP)

    if text == "":
        return _unresolved(original, favorite, receiver, "handicap source empty")

    # 1) Japanese half notation. MUST be handled before decimal parsing and MUST
    #    NOT be collapsed to 1.5.
    m = _JP_HALF_RE.match(text)
    if m:
        base = int(m.group(1))
        sub = m.group(2)
        if sub is None:
            return Handicap(
                handicap_raw=original,
                handicap_display=f"{base}{_HALF_CHAR}",
                handicap_type=HandicapType.JP_HALF,
                handicap_value=None,  # intentionally NOT 1.5 / not a decimal
                handicap_sub_number=None,
                handicap_settlement_rule=RULE_JP_HALF,
                favorite=favorite,
                receiver=receiver,
                rule_status=HandicapRuleStatus.RESOLVED,
                notes=(
                    "JP_HALF preserved as distinct type; not normalized to a decimal.",
                ),
            )
        return Handicap(
            handicap_raw=original,
            handicap_display=f"{base}{_HALF_CHAR}{sub}",
            handicap_type=HandicapType.JP_HALF_SUB,
            handicap_value=None,
            handicap_sub_number=int(sub),
            handicap_settlement_rule=RULE_JP_HALF_SUB,
            favorite=favorite,
            receiver=receiver,
            rule_status=HandicapRuleStatus.RESOLVED,
            notes=(
                f"JP_HALF_SUB base={base} sub={sub}; preserved distinctly.",
            ),
        )

    # A stray half character we could not fully match -> unresolved, never guess.
    if _HALF_CHAR in text:
        return _unresolved(original, favorite, receiver, "ambiguous half notation")

    # 2) Plain integer.
    if _INTEGER_RE.match(text):
        try:
            value = Decimal(text)
        except InvalidOperation:
            return _unresolved(original, favorite, receiver, "unparseable integer")
        return Handicap(
            handicap_raw=original,
            handicap_display=text,
            handicap_type=HandicapType.INTEGER,
            handicap_value=value,
            handicap_settlement_rule=RULE_INTEGER,
            favorite=favorite,
            receiver=receiver,
            rule_status=HandicapRuleStatus.RESOLVED,
        )

    # 3) Decimal (covers 0.x and 1.x including 1.0).
    if _DECIMAL_RE.match(text):
        try:
            value = Decimal(text)
        except InvalidOperation:
            return _unresolved(original, favorite, receiver, "unparseable decimal")
        return Handicap(
            handicap_raw=original,
            handicap_display=text,
            handicap_type=HandicapType.DECIMAL,
            handicap_value=value,
            handicap_settlement_rule=RULE_DECIMAL,
            favorite=favorite,
            receiver=receiver,
            rule_status=HandicapRuleStatus.RESOLVED,
        )

    return _unresolved(original, favorite, receiver, "unsupported handicap notation")


def _unresolved(
    raw: str, favorite: str | None, receiver: str | None, reason: str
) -> Handicap:
    return Handicap(
        handicap_raw=raw,
        handicap_display=raw,
        handicap_type=HandicapType.UNRESOLVED,
        handicap_value=None,
        handicap_sub_number=None,
        handicap_settlement_rule=RULE_UNRESOLVED,
        favorite=favorite,
        receiver=receiver,
        rule_status=HandicapRuleStatus.UNRESOLVED,
        notes=(reason,),
    )
