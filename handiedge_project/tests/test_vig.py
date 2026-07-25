"""Vig / overround removal tests (audit category 3)."""

from __future__ import annotations

import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from handiedge.probability.implied import (
    decimal_to_implied,
    remove_vig,
)


@pytest.mark.parametrize("method", ["multiplicative", "additive", "shin"])
def test_two_way_sums_to_one_exactly(method):
    fair = remove_vig([1.91, 1.91], method=method)
    assert math.isclose(sum(fair.probabilities), 1.0, abs_tol=1e-9)
    assert fair.overround > 0  # -110/-110 book has margin


@pytest.mark.parametrize("method", ["multiplicative", "additive", "shin"])
def test_multiway_sums_to_one(method):
    # Three-way soccer market.
    fair = remove_vig([2.5, 3.4, 3.0], method=method)
    assert math.isclose(sum(fair.probabilities), 1.0, abs_tol=1e-9)
    assert len(fair.probabilities) == 3


def test_favorite_has_higher_fair_prob():
    fair = remove_vig([1.5, 3.0])
    assert fair.probabilities[0] > fair.probabilities[1]


def test_raw_implied_greater_than_fair():
    odds = [1.8, 2.0]
    raw = [decimal_to_implied(o) for o in odds]
    fair = remove_vig(odds, method="multiplicative")
    # Fair probabilities are each <= raw implied because vig is stripped.
    assert all(f <= r + 1e-12 for f, r in zip(fair.probabilities, raw, strict=True))


def test_invalid_odds_rejected():
    with pytest.raises(ValueError):
        remove_vig([1.0, 2.0])
    with pytest.raises(ValueError):
        remove_vig([2.0])  # need >= 2 outcomes


@given(
    st.lists(st.floats(min_value=1.05, max_value=20.0), min_size=2, max_size=5),
    st.sampled_from(["multiplicative", "additive", "shin"]),
)
def test_property_fair_probs_valid(odds, method):
    fair = remove_vig(odds, method=method)
    assert math.isclose(sum(fair.probabilities), 1.0, abs_tol=1e-6)
    assert all(0.0 <= p <= 1.0 for p in fair.probabilities)
