"""Shared fixtures: a seeded event with a two-point line history and core-4 picks."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest

from handiedge.domain.events import Event
from handiedge.domain.taxonomy import MarketType, Sport
from handiedge.features.builder import FeatureBuilder
from handiedge.features.store import HumanPrediction, HumanPredictionStore
from handiedge.odds.ingestion import OddsIngestor
from handiedge.odds.models import OddsQuote, OddsSource


@dataclass
class Seed:
    event: Event
    ingestor: OddsIngestor
    humans: HumanPredictionStore
    scheduled_at: datetime
    feature_builder: FeatureBuilder


@pytest.fixture
def seed() -> Seed:
    # Anchor near real "now" so PredictionService.predict() (which defaults
    # as_of to the current time) sees the line history as recent-but-past and
    # within the ingestor's stale window. Tests that need fixed dates build
    # their own quotes instead of using this fixture.
    scheduled = datetime.now(UTC) + timedelta(minutes=20)
    event = Event(
        event_id=Event.new_id(),
        sport=Sport.NPB,
        league="NPB-CENTRAL",
        team_home="Giants",
        team_away="Tigers",
        scheduled_at=scheduled,
    )
    ing = OddsIngestor(stale_seconds=3600)
    # T-90min line = -1.5 ; T-30min line = -2.0 (published later)
    for minutes, line, closing in [(90, -1.5, False), (30, -2.0, True)]:
        pub = scheduled - timedelta(minutes=minutes)
        ing.ingest(
            OddsQuote(
                quote_id=uuid.uuid4(),
                event_id=event.event_id,
                market_type=MarketType.HANDICAP,
                source=OddsSource.API,
                bookmaker="bookA",
                published_at=pub,
                ingested_at=pub,
                odds_a=1.91,
                odds_b=1.91,
                line=line,
                is_closing=closing,
            )
        )
    humans = HumanPredictionStore()
    humans.add(
        HumanPrediction(
            event_id=event.event_id,
            predictor_id="core4_alpha",
            role="core4",
            pick_side="A",
            submitted_at=scheduled - timedelta(minutes=120),
        )
    )
    fb = FeatureBuilder(ing, humans)
    return Seed(event, ing, humans, scheduled, fb)
