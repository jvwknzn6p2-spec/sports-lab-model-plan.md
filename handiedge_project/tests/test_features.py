"""As-of / leakage regression tests (audit category 5)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest

from handiedge.domain.taxonomy import MarketType
from handiedge.odds.models import OddsQuote, OddsSource


def test_features_ignore_future_handicaps(seed):
    as_of = seed.scheduled_at - timedelta(minutes=60)
    fv = seed.feature_builder.build(seed.event, as_of)
    # Only the T-90min line (-1.5) is visible at T-60; T-30 (-2.0) must be excluded.
    assert fv.handicap_a == -1.5, "future handicap leaked into features"


def test_as_of_must_be_timezone_aware(seed):
    with pytest.raises(AssertionError):
        seed.feature_builder.build(seed.event, datetime.now())  # naive


def test_feature_value_stable_when_future_rows_added(seed):
    """The canonical no-leakage test: appending future rows must not change a
    feature computed at an earlier as_of."""
    as_of = seed.scheduled_at - timedelta(minutes=60)
    before = seed.feature_builder.build(seed.event, as_of).fingerprint()

    # Append a brand-new line published AFTER as_of.
    later = seed.scheduled_at - timedelta(minutes=10)
    seed.ingestor.ingest(
        OddsQuote(
            quote_id=uuid.uuid4(),
            event_id=seed.event.event_id,
            market_type=MarketType.HANDICAP,
            source=OddsSource.API,
            bookmaker="bookB",
            published_at=later,
            ingested_at=later,
            odds_a=1.8,
            odds_b=2.0,
            line=-3.0,
            is_closing=False,
        )
    )
    after = seed.feature_builder.build(seed.event, as_of).fingerprint()
    assert before == after, "feature vector changed after future rows were added (leakage)"


def test_core4_picks_after_as_of_excluded(seed):
    from handiedge.features.store import HumanPrediction

    as_of = seed.scheduled_at - timedelta(minutes=60)
    base = seed.feature_builder.build(seed.event, as_of).pct_core4_pick_a
    # Add a core-4 pick submitted AFTER as_of; it must not affect the aggregate.
    seed.humans.add(
        HumanPrediction(
            event_id=seed.event.event_id,
            predictor_id="core4_beta",
            role="core4",
            pick_side="B",
            submitted_at=seed.scheduled_at - timedelta(minutes=5),
        )
    )
    after = seed.feature_builder.build(seed.event, as_of).pct_core4_pick_a
    assert base == after == 1.0
