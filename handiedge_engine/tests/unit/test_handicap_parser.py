"""Handicap parser tests, including the critical 1半 preservation rule."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.enums import HandicapRuleStatus, HandicapType
from app.domain.handicap.parser import parse_handicap


def test_integer_handicap():
    h = parse_handicap("1", favorite="A", receiver="B")
    assert h.handicap_type is HandicapType.INTEGER
    assert h.handicap_value == Decimal("1")
    assert h.is_resolved


def test_zero_handicap():
    h = parse_handicap("0")
    assert h.handicap_type is HandicapType.INTEGER
    assert h.handicap_value == Decimal("0")


@pytest.mark.parametrize("raw,expected", [("0.5", "0.5"), ("1.0", "1.0"), ("1.25", "1.25")])
def test_decimal_handicap(raw, expected):
    h = parse_handicap(raw)
    assert h.handicap_type is HandicapType.DECIMAL
    assert h.handicap_value == Decimal(expected)


def test_jp_half_is_not_normalized_to_1_5():
    """1半 MUST be preserved distinctly and MUST NOT become the decimal 1.5."""

    h = parse_handicap("1半", favorite="A", receiver="B")
    assert h.handicap_type is HandicapType.JP_HALF
    assert h.handicap_value is None  # explicitly not 1.5
    assert h.handicap_display == "1半"
    assert h.handicap_settlement_rule == "HDP_JP_HALF_V1"
    assert h.is_resolved


def test_jp_half_sub_numbers():
    for n in range(1, 10):
        h = parse_handicap(f"1半{n}")
        assert h.handicap_type is HandicapType.JP_HALF_SUB
        assert h.handicap_sub_number == n
        assert h.handicap_value is None


def test_fullwidth_digits_normalized():
    h = parse_handicap("１半３")
    assert h.handicap_type is HandicapType.JP_HALF_SUB
    assert h.handicap_sub_number == 3


@pytest.mark.parametrize("raw", ["1半A", "half", "1..5", "?", "1半10", ""])
def test_unsupported_notation_is_unresolved_not_guessed(raw):
    h = parse_handicap(raw)
    assert h.handicap_type is HandicapType.UNRESOLVED
    assert h.rule_status is HandicapRuleStatus.UNRESOLVED
    assert h.handicap_value is None


def test_none_input_is_unresolved():
    h = parse_handicap(None)
    assert h.handicap_type is HandicapType.UNRESOLVED
