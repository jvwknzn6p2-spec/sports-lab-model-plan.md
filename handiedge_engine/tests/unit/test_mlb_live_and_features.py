"""Unit tests for the live MLB feed parsers and shared sabermetrics."""

from __future__ import annotations

from app.domain.feature_engineering import sabermetrics
from app.infrastructure.data_sources.mlb_live import (
    parse_pitcher_seasons,
    parse_slate,
    parse_team_hitting,
)

SCHEDULE = {
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
                        "home": {
                            "team": {"id": 147, "name": "New York Yankees"},
                            "probablePitcher": {"id": 543037, "fullName": "Gerrit Cole"},
                        },
                        "away": {
                            "team": {"id": 111, "name": "Boston Red Sox"},
                            "probablePitcher": {"id": 656794, "fullName": "Brayan Bello"},
                        },
                    },
                    "venue": {"id": 3313, "name": "Yankee Stadium"},
                },
                {
                    # A finished game must be excluded from a prediction slate.
                    "gamePk": 999,
                    "gameDate": "2026-07-25T18:00:00Z",
                    "officialDate": "2026-07-25",
                    "status": {"detailedState": "Final", "abstractGameState": "Final"},
                    "teams": {
                        "home": {"team": {"id": 121, "name": "New York Mets"}},
                        "away": {"team": {"id": 120, "name": "Washington Nationals"}},
                    },
                    "venue": {"id": 3289, "name": "Citi Field"},
                },
            ],
        }
    ]
}


def test_parse_slate_excludes_final_games():
    slate = parse_slate(SCHEDULE)
    assert len(slate) == 1
    g = slate[0]
    assert g.game_pk == "111"
    assert g.home_team == "New York Yankees"
    assert g.home_team_id == "147"
    assert g.home_starter.pitcher_id == "543037"
    assert g.home_starter.confirmed is True
    assert g.venue_id == "3313"


def test_parse_pitcher_seasons():
    payload = {
        "people": [
            {
                "id": 543037,
                "fullName": "Gerrit Cole",
                "stats": [
                    {"splits": [{"stat": {"era": "2.90", "whip": "1.05",
                                          "inningsPitched": "120.1", "gamesStarted": "20"}}]}
                ],
            },
            {"id": 700000, "fullName": "Debut Arm", "stats": []},  # no season line yet
        ]
    }
    seasons = parse_pitcher_seasons(payload)
    assert seasons["543037"].era == 2.90
    assert seasons["543037"].whip == 1.05
    assert abs(seasons["543037"].innings_pitched - (120 + 1 / 3)) < 1e-6
    # No fabricated numbers for a pitcher with no line.
    assert seasons["700000"].era is None


def test_parse_team_hitting_computes_woba():
    payload = {
        "stats": [
            {
                "splits": [
                    {
                        "stat": {
                            "atBats": 3500, "hits": 900, "doubles": 180, "triples": 15,
                            "homeRuns": 150, "baseOnBalls": 350, "intentionalWalks": 20,
                            "hitByPitch": 40, "sacFlies": 30, "gamesPlayed": 100,
                        }
                    }
                ]
            }
        ]
    }
    th = parse_team_hitting(payload, "147")
    assert th.games == 100
    # Cross-check against the shared sabermetrics formula.
    singles = 900 - 180 - 15 - 150
    expected = sabermetrics.woba(
        at_bats=3500, walks=350, intentional_walks=20, hit_by_pitch=40,
        singles=singles, doubles=180, triples=15, home_runs=150, sac_flies=30,
    )
    assert th.woba == expected
    assert 0.2 < th.woba < 0.5  # sane wOBA range


def test_sabermetrics_edge_cases():
    assert sabermetrics.earned_run_average(0, 0) is None
    assert sabermetrics.whip(0, 0, 0) is None
    assert sabermetrics.earned_run_average(10, 90) == 1.0
