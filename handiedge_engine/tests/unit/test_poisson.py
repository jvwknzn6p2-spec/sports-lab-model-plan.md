"""Independent-Poisson margin model tests."""

from __future__ import annotations

from decimal import Decimal

from app.domain.prediction.poisson import margin_distribution, moneyline_from_margin


def test_margin_distribution_sums_to_one():
    dist = margin_distribution(4.6, 4.1)
    total = sum(dist.values())
    assert total == Decimal("1")


def test_margin_distribution_is_deterministic():
    a = margin_distribution(5.0, 3.5)
    b = margin_distribution(5.0, 3.5)
    assert a == b


def test_higher_mean_shifts_mass_positive():
    dist = margin_distribution(6.0, 3.0)
    positive = sum(p for m, p in dist.items() if int(m) > 0)
    negative = sum(p for m, p in dist.items() if int(m) < 0)
    assert positive > negative


def test_moneyline_sums_to_one_and_favors_higher_mean():
    dist = margin_distribution(5.5, 4.0)
    home_p, away_p = moneyline_from_margin(dist)
    assert (home_p + away_p) == Decimal("1")
    assert home_p > away_p


def test_symmetric_means_give_even_moneyline():
    dist = margin_distribution(4.5, 4.5)
    home_p, away_p = moneyline_from_margin(dist)
    assert abs(home_p - Decimal("0.5")) < Decimal("0.01")
