"""Integration test: live-shaped MLB data -> daily prediction, fully offline.

Uses an injected transport that returns recorded-shape fixtures, so the whole
Feature Engineering -> Prediction -> Calibration -> AI review path runs with no
network and deterministic output.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from app.core.enums import League
from app.domain.report.daily import render_daily_report
from app.infrastructure.data_sources.mlb_live import MlbLiveFeed
from app.services.daily_slate_service import DailySlateService
from app.services.orchestration_service import OrchestrationService

pytestmark = pytest.mark.integration

_SCHEDULE = {
    "dates": [
        {
            "date": "2026-07-25",
            "games": [
                {
                    "gamePk": 111,
                    "gameDate": "2026-07-25T23:05:00Z",
                    "officialDate": "2026-07-25",
                    "status": {"detailedState": "Scheduled", "abstractGameState": "Preview"},
                    "teams": {
                        "home": {"team": {"id": 147, "name": "New York Yankees"},
                                 "probablePitcher": {"id": 543037, "fullName": "Gerrit Cole"}},
                        "away": {"team": {"id": 111, "name": "Boston Red Sox"},
                                 "probablePitcher": {"id": 656794, "fullName": "Brayan Bello"}},
                    },
                    "venue": {"id": 3313, "name": "Yankee Stadium"},
                },
                {
                    "gamePk": 222,
                    "gameDate": "2026-07-26T02:10:00Z",
                    "officialDate": "2026-07-25",
                    "status": {"detailedState": "Pre-Game", "abstractGameState": "Preview"},
                    "teams": {
                        "home": {"team": {"id": 119, "name": "Los Angeles Dodgers"},
                                 "probablePitcher": {"id": 808967, "fullName": "Yamamoto"}},
                        "away": {"team": {"id": 137, "name": "San Francisco Giants"},
                                 "probablePitcher": {"id": 657277, "fullName": "Webb"}},
                    },
                    "venue": {"id": 22, "name": "Dodger Stadium"},
                },
            ],
        }
    ]
}

_PITCHERS = {
    "people": [
        {"id": 543037, "fullName": "Gerrit Cole",
         "stats": [{"splits": [{"stat": {"era": "2.90", "whip": "1.05",
                                         "inningsPitched": "120.1", "gamesStarted": "20"}}]}]},
        {"id": 656794, "fullName": "Brayan Bello",
         "stats": [{"splits": [{"stat": {"era": "4.10", "whip": "1.32",
                                         "inningsPitched": "110.0", "gamesStarted": "19"}}]}]},
        {"id": 808967, "fullName": "Yoshinobu Yamamoto",
         "stats": [{"splits": [{"stat": {"era": "3.10", "whip": "1.10",
                                         "inningsPitched": "115.0", "gamesStarted": "19"}}]}]},
        {"id": 657277, "fullName": "Logan Webb",
         "stats": [{"splits": [{"stat": {"era": "3.40", "whip": "1.18",
                                         "inningsPitched": "140.0", "gamesStarted": "22"}}]}]},
    ]
}


def _team_hitting(team_id: str) -> dict[str, Any]:
    return {
        "stats": [{"splits": [{"stat": {
            "atBats": 3500, "hits": 900, "doubles": 180, "triples": 15, "homeRuns": 150,
            "baseOnBalls": 350, "intentionalWalks": 20, "hitByPitch": 40, "sacFlies": 30,
            "gamesPlayed": 100,
        }}]}]
    }


class _FakeTransport:
    def get_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if url.endswith("/schedule"):
            return _SCHEDULE
        if url.endswith("/people"):
            return _PITCHERS
        if "/teams/" in url and url.endswith("/stats"):
            team_id = url.split("/teams/")[1].split("/")[0]
            return _team_hitting(team_id)
        raise AssertionError(f"unexpected URL {url}")


def _build_and_run(session, settings, adapter):
    feed = MlbLiveFeed(transport=_FakeTransport())
    result = DailySlateService(feed).build_payload(date(2026, 7, 25), league=League.MLB)
    service = OrchestrationService(session, settings, adapter)
    response = service.run_pipeline(
        result.payload.model_dump(mode="json"), correlation_id="daily-test"
    )
    return result, response


def test_daily_slate_builds_engineered_features(session, settings, adapter):
    result, _ = _build_and_run(session, settings, adapter)
    assert result.games_found == 2
    assert result.games_included == 2
    game = result.payload.games[0]
    extra = game.feature_summary.model_extra or {}
    # Real engineered features from the season stats, not fabricated.
    assert extra["home_starter_era"] == 2.90
    assert extra["away_starter_era"] == 4.10
    assert 0.2 < extra["home_team_woba"] < 0.5
    # Core signal complete -> high completeness; enhancers flagged missing.
    assert game.feature_summary.completeness == 1.0
    assert "implied_home_win_probability" in game.feature_summary.missing_features


def test_daily_pipeline_generates_predictions(session, settings, adapter):
    _, response = _build_and_run(session, settings, adapter)
    assert response.summary.total_games == 2
    # Starters + offense present -> the slate should PREDICT, not PASS on completeness.
    assert response.summary.predictions == 2
    for game in response.games:
        assert game.decision_status == "PREDICT"
        assert game.confidence_tier != "NONE"
        assert game.ai_review is not None  # Step 9 ran


def test_daily_report_renders(session, settings, adapter):
    _, response = _build_and_run(session, settings, adapter)
    report = render_daily_report(response)
    assert "AI SPORTS LAB" in report
    assert "predictions for 2026-07-25" in report
    assert "Summary:" in report
