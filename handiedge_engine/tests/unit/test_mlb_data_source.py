"""MLB Stats API parsing + cached-feed tests (no network access required)."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from app.infrastructure.data_sources.mlb_stats_api import (
    MlbStatsApiFeed,
    parse_boxscore,
    parse_schedule,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture()
def schedule_payload() -> dict:
    return json.loads((FIXTURES / "mlb_schedule.json").read_text())


@pytest.fixture()
def boxscore_payload() -> dict:
    return json.loads((FIXTURES / "mlb_boxscore.json").read_text())


def test_parse_schedule_returns_only_completed_games(schedule_payload):
    games = parse_schedule(schedule_payload)
    # The postponed game must be excluded — never train/settle on an unfinished result.
    assert [g.game_pk for g in games] == ["745001", "745002", "745010"]


def test_parse_schedule_is_chronological(schedule_payload):
    games = parse_schedule(schedule_payload)
    assert [g.game_date for g in games] == [
        date(2024, 7, 4),
        date(2024, 7, 4),
        date(2024, 7, 5),
    ]


def test_parse_schedule_extracts_teams_and_scores(schedule_payload):
    game = parse_schedule(schedule_payload)[0]
    assert game.home_team == "New York Yankees"
    assert game.away_team == "Boston Red Sox"
    assert (game.home_runs, game.away_runs) == (5, 3)
    assert game.venue_id == "3313"
    assert game.home_probable_pitcher_id == "543037"


def test_regulation_nine_matches_final_for_nine_inning_game(schedule_payload):
    game = parse_schedule(schedule_payload)[0]
    assert game.innings_played == 9
    assert game.went_extra_innings is False
    assert (game.home_runs_reg9, game.away_runs_reg9) == (5, 3)


def test_regulation_nine_excludes_extra_innings(schedule_payload):
    """The extra-innings game must expose a distinct regulation-9 score.

    This is what makes NPB_REG9_ONLY settlement possible without substituting
    an MLB-style final that includes extra innings.
    """

    game = parse_schedule(schedule_payload)[1]
    assert game.went_extra_innings is True
    assert (game.home_runs, game.away_runs) == (7, 6)
    # Innings 10-11 contributed 2 home / 1 away runs; regulation is 5-5 (a tie).
    assert (game.home_runs_reg9, game.away_runs_reg9) == (5, 5)


def test_parse_boxscore_pitcher_lines(boxscore_payload):
    box = parse_boxscore(boxscore_payload, "745001")
    starter = box.home_pitchers[0]
    assert starter.pitcher_id == "543037"
    assert starter.is_starter is True
    # "6.2" means 6 and 2/3 innings, not 6.2 innings.
    assert starter.innings_pitched == pytest.approx(6 + 2 / 3)
    assert starter.earned_runs == 2

    reliever = box.home_pitchers[1]
    assert reliever.is_starter is False
    assert reliever.innings_pitched == pytest.approx(2 + 1 / 3)


def test_parse_boxscore_ignores_non_pitchers(boxscore_payload):
    box = parse_boxscore(boxscore_payload, "745001")
    ids = {p.pitcher_id for p in box.home_pitchers}
    assert "592450" not in ids  # position player with only batting stats


def test_parse_boxscore_team_batting(boxscore_payload):
    box = parse_boxscore(boxscore_payload, "745001")
    batting = box.home_batting
    assert batting.at_bats == 34
    assert batting.home_runs == 2
    # singles = hits - 2B - 3B - HR
    assert batting.singles == 10 - 2 - 0 - 2


class _RecordingTransport:
    """Counts network calls so cache behaviour can be asserted."""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls = 0

    def get_json(self, url: str, params=None) -> dict:
        self.calls += 1
        return self.payload


def test_feed_caches_responses_to_disk(tmp_path, schedule_payload):
    transport = _RecordingTransport(schedule_payload)
    feed = MlbStatsApiFeed(cache_dir=tmp_path, transport=transport)

    first = feed.fetch_schedule(date(2024, 7, 4), date(2024, 7, 5))
    second = feed.fetch_schedule(date(2024, 7, 4), date(2024, 7, 5))

    assert transport.calls == 1  # second call served from the on-disk cache
    assert [g.game_pk for g in first] == [g.game_pk for g in second]
    assert (tmp_path / "schedule_2024-07-04_2024-07-05.json").exists()


def test_feed_reuses_cache_across_instances(tmp_path, boxscore_payload):
    transport = _RecordingTransport(boxscore_payload)
    MlbStatsApiFeed(cache_dir=tmp_path, transport=transport).fetch_boxscore("745001")

    # A fresh feed with a transport that would fail if called must still succeed.
    class _ExplodingTransport:
        def get_json(self, url: str, params=None) -> dict:
            raise AssertionError("cache miss: network should not be used")

    box = MlbStatsApiFeed(cache_dir=tmp_path, transport=_ExplodingTransport()).fetch_boxscore(
        "745001"
    )
    assert box.game_pk == "745001"
