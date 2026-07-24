"""Handicap settlement rule tests — proving 1半 != 1.5 at settlement."""

from __future__ import annotations

from app.domain.handicap.parser import parse_handicap
from app.domain.settlement.handicap_rules import (
    HandicapOutcome,
    settle_favorite_margin,
)


def test_integer_handicap_push():
    h = parse_handicap("1", favorite="A", receiver="B")
    assert settle_favorite_margin(h, 1) is HandicapOutcome.PUSH
    assert settle_favorite_margin(h, 2) is HandicapOutcome.WIN
    assert settle_favorite_margin(h, 0) is HandicapOutcome.LOSS


def test_half_line_never_pushes():
    h = parse_handicap("1.5", favorite="A", receiver="B")
    assert settle_favorite_margin(h, 2) is HandicapOutcome.WIN
    assert settle_favorite_margin(h, 1) is HandicapOutcome.LOSS


def test_quarter_line_partial_outcomes():
    h = parse_handicap("0.25", favorite="A", receiver="B")
    # split {0.0, 0.5}: margin 0 -> leg1 push(+0) leg2 loss(-1) => -0.5 partial loss
    assert settle_favorite_margin(h, 0) is HandicapOutcome.PARTIAL_LOSS
    assert settle_favorite_margin(h, 1) is HandicapOutcome.WIN


def test_jp_half_differs_from_decimal_1_5():
    jp = parse_handicap("1半", favorite="A", receiver="B")
    dec = parse_handicap("1.5", favorite="A", receiver="B")
    # At a favorite margin of exactly 2:
    #   1.5 decimal -> full WIN
    #   1半 split{1,2} -> PARTIAL_WIN (half win, half push)
    assert settle_favorite_margin(dec, 2) is HandicapOutcome.WIN
    assert settle_favorite_margin(jp, 2) is HandicapOutcome.PARTIAL_WIN
    # At margin 1:
    assert settle_favorite_margin(dec, 1) is HandicapOutcome.LOSS
    assert settle_favorite_margin(jp, 1) is HandicapOutcome.PARTIAL_LOSS
    # At margin 3 both are full wins:
    assert settle_favorite_margin(jp, 3) is HandicapOutcome.WIN


def test_jp_half_sub_weighting():
    # 1半9 leans heavily on the base+1 line.
    h = parse_handicap("1半9", favorite="A", receiver="B")
    # margin 2: leg1(line1) win(+1) w=0.1; leg2(line2) push(0) w=0.9 => +0.1 partial win
    assert settle_favorite_margin(h, 2) is HandicapOutcome.PARTIAL_WIN
