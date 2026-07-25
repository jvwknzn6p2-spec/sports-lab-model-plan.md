"""As-of dataset builder tests, focused on leakage prevention.

Leakage is the failure mode that silently inflates offline metrics and destroys
live performance, so it is asserted structurally: a row must be invariant to
anything that happens on or after its own game date.
"""

from __future__ import annotations

import copy
from dataclasses import replace
from datetime import date

from app.domain.prediction.dataset import (
    DERIVED_FEATURES,
    UNSOURCED_FEATURES,
    AsOfDatasetBuilder,
    DatasetRow,
)
from app.domain.prediction.features import FEATURE_NAMES
from app.infrastructure.data_sources.mlb_stats_api import (
    GameBoxscore,
    PitcherLine,
    ScheduleGame,
    TeamBattingLine,
)

_IDX = {name: i for i, name in enumerate(FEATURE_NAMES)}


def _game(pk: str, day: int, home: str, away: str, hr: int, ar: int) -> ScheduleGame:
    return ScheduleGame(
        game_pk=pk,
        game_date=date(2024, 7, day),
        home_team=home,
        away_team=away,
        home_runs=hr,
        away_runs=ar,
        home_runs_reg9=hr,
        away_runs_reg9=ar,
        innings_played=9,
        venue_id=f"venue-{home}",
        home_probable_pitcher_id=f"sp-{home}",
        away_probable_pitcher_id=f"sp-{away}",
    )


def _boxscore(game: ScheduleGame) -> GameBoxscore:
    def side(team: str, runs_allowed: int) -> tuple:
        return (
            PitcherLine(f"sp-{team}", 6.0, runs_allowed, 6, 2, True),
            PitcherLine(f"rp-{team}", 3.0, 1, 3, 1, False),
        )

    batting = TeamBattingLine(
        at_bats=34, hits=9, doubles=2, triples=0, home_runs=1,
        walks=3, intentional_walks=0, hit_by_pitch=1, sac_flies=1,
    )
    return GameBoxscore(
        game_pk=game.game_pk,
        home_pitchers=side(game.home_team, game.away_runs),
        away_pitchers=side(game.away_team, game.home_runs),
        home_batting=batting,
        away_batting=batting,
    )


def _season(days: int = 14) -> list[ScheduleGame]:
    """A small round-robin season with repeating teams so state accumulates."""

    teams = ["NYY", "BOS", "LAD", "SF"]
    games: list[ScheduleGame] = []
    for day in range(1, days + 1):
        games.append(_game(f"g{day}a", day, teams[0], teams[1], 4 + day % 3, 2 + day % 4))
        games.append(_game(f"g{day}b", day, teams[2], teams[3], 3 + day % 4, 5 - day % 3))
    return games


def _build(games: list[ScheduleGame]) -> list[DatasetRow]:
    lookup = {g.game_pk: _boxscore(g) for g in games}
    builder = AsOfDatasetBuilder(boxscore_lookup=lambda pk: lookup.get(pk))
    return builder.build(games)


# --------------------------------------------------------------------------- #
# Leakage
# --------------------------------------------------------------------------- #


def test_first_games_have_no_derived_features():
    """With zero prior history nothing can be derived — and nothing is invented."""

    rows = _build(_season(1))
    for row in rows:
        assert all(value is None for value in row.features)


def test_row_is_unchanged_by_later_games():
    """The core leakage assertion: mutating the future cannot change the past."""

    games = _season()
    baseline = _build(games)

    mutated = copy.deepcopy(games)
    # Blow out the scores of every game from day 10 onward.
    mutated = [
        replace(g, home_runs=99, away_runs=0) if g.game_date >= date(2024, 7, 10) else g
        for g in mutated
    ]
    after = _build(mutated)

    early_baseline = [r for r in baseline if r.game_date < "2024-07-10"]
    early_after = [r for r in after if r.game_date < "2024-07-10"]
    assert [r.features for r in early_baseline] == [r.features for r in early_after]


def test_row_does_not_use_its_own_result():
    """A game's own score must not appear in its own features."""

    games = _season()
    baseline = _build(games)
    target_pk = games[-1].game_pk

    mutated = [
        replace(g, home_runs=g.home_runs + 25) if g.game_pk == target_pk else g
        for g in games
    ]
    after = _build(mutated)

    before_row = next(r for r in baseline if r.game_pk == target_pk)
    after_row = next(r for r in after if r.game_pk == target_pk)
    assert before_row.features == after_row.features
    # The target itself must reflect the change (it is the label, not a feature).
    assert after_row.home_runs == before_row.home_runs + 25


def test_same_day_games_do_not_inform_each_other():
    """Two games on the same date must not see one another's results."""

    games = _season()
    baseline = _build(games)
    # Mutate only the *second* game of the final day.
    last_day = max(g.game_date for g in games)
    same_day = [g for g in games if g.game_date == last_day]
    victim, sibling = same_day[0], same_day[1]

    mutated = [
        replace(g, home_runs=50) if g.game_pk == sibling.game_pk else g for g in games
    ]
    after = _build(mutated)

    before_row = next(r for r in baseline if r.game_pk == victim.game_pk)
    after_row = next(r for r in after if r.game_pk == victim.game_pk)
    assert before_row.features == after_row.features


def test_earlier_games_do_influence_later_features():
    """Sanity check the inverse: history must actually feed the features."""

    games = _season()
    baseline = _build(games)

    mutated = [
        replace(g, home_runs=40) if g.game_date == date(2024, 7, 1) else g for g in games
    ]
    after = _build(mutated)

    last_pk = games[-1].game_pk
    before_row = next(r for r in baseline if r.game_pk == last_pk)
    after_row = next(r for r in after if r.game_pk == last_pk)
    assert before_row.features != after_row.features


# --------------------------------------------------------------------------- #
# Feature sourcing honesty
# --------------------------------------------------------------------------- #


def test_unsourced_features_are_none_without_external_feeds():
    """Weather/market inputs are never fabricated when no source is supplied."""

    rows = _build(_season())
    for row in rows:
        for name in UNSOURCED_FEATURES:
            assert row.features[_IDX[name]] is None, name


def _build_with_feeds(games, weather=True, odds=True):
    lookup = {g.game_pk: _boxscore(g) for g in games}
    builder = AsOfDatasetBuilder(
        boxscore_lookup=lambda pk: lookup.get(pk),
        weather_lookup=(lambda d, v: (75.0, 8.0)) if weather else None,
        odds_lookup=(lambda d, h, a: 0.57) if odds else None,
    )
    return builder.build(games)


def test_weather_and_odds_feeds_populate_the_remaining_features():
    rows = _build_with_feeds(_season())
    for row in rows:
        assert row.features[_IDX["temp_f"]] == 75.0
        assert row.features[_IDX["wind_mph"]] == 8.0
        assert row.features[_IDX["implied_home_win_probability"]] == 0.57


def test_every_contract_feature_is_populated_with_all_feeds():
    """With history + weather + odds, no feature in the contract stays inert."""

    final = _build_with_feeds(_season())[-1]
    assert all(value is not None for value in final.features)


def test_weather_only_leaves_odds_unsourced():
    final = _build_with_feeds(_season(), weather=True, odds=False)[-1]
    assert final.features[_IDX["temp_f"]] is not None
    assert final.features[_IDX["implied_home_win_probability"]] is None


def test_external_feeds_do_not_break_leakage_safety():
    """Adding weather/odds must not make a row depend on later games."""

    games = _season()
    baseline = _build_with_feeds(games)
    mutated = [
        replace(g, home_runs=99, away_runs=0) if g.game_date >= date(2024, 7, 10) else g
        for g in games
    ]
    after = _build_with_feeds(mutated)

    early_baseline = [r.features for r in baseline if r.game_date < "2024-07-10"]
    early_after = [r.features for r in after if r.game_date < "2024-07-10"]
    assert early_baseline == early_after


def test_odds_lookup_receives_the_matchup():
    """The odds source must be keyed by date and both teams, not just date."""

    seen: list[tuple] = []

    def odds_lookup(game_date, home, away):
        seen.append((game_date, home, away))
        return 0.5

    games = _season(2)
    lookup = {g.game_pk: _boxscore(g) for g in games}
    AsOfDatasetBuilder(
        boxscore_lookup=lambda pk: lookup.get(pk), odds_lookup=odds_lookup
    ).build(games)

    assert len(seen) == len(games)
    assert all(isinstance(d, date) and h and a for d, h, a in seen)


def test_derived_features_populate_once_history_accumulates():
    rows = _build(_season())
    final = rows[-1]
    populated = {
        name for name in DERIVED_FEATURES if final.features[_IDX[name]] is not None
    }
    # Every derivable feature should be available late in the season.
    assert populated == set(DERIVED_FEATURES)


def test_derived_values_are_plausible():
    rows = _build(_season())
    final = rows[-1]
    era = final.features[_IDX["home_starter_era"]]
    whip = final.features[_IDX["home_starter_whip"]]
    woba = final.features[_IDX["home_team_woba"]]
    rest = final.features[_IDX["home_bullpen_rest_days"]]
    park = final.features[_IDX["park_factor"]]

    assert 0.0 < era < 20.0
    assert 0.0 < whip < 5.0
    assert 0.0 < woba < 1.0
    assert rest >= 0.0
    assert 0.0 < park < 3.0


def test_rows_align_to_feature_contract():
    rows = _build(_season(3))
    assert all(len(r.features) == len(FEATURE_NAMES) for r in rows)


def test_dataset_row_json_roundtrip():
    row = _build(_season(3))[-1]
    restored = DatasetRow.from_json(row.to_json())
    assert restored == row


def test_builder_is_deterministic():
    games = _season()
    assert [r.features for r in _build(games)] == [r.features for r in _build(games)]


def test_postponed_games_never_enter_the_dataset():
    """Only completed games reach the builder (parse_schedule filters the rest),
    so every emitted row must carry a real, scoreable result."""

    rows = _build(_season(4))
    assert all(r.home_runs >= 0 and r.away_runs >= 0 for r in rows)
    assert len(rows) == 8  # 2 games/day * 4 days, none dropped or duplicated
