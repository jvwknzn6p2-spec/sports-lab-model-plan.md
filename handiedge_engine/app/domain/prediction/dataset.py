"""Leakage-safe training dataset construction from historical games.

The single most important property here is **no future information leakage**: the
feature vector for a game must be computable from information available *before*
that game started. This module enforces that structurally:

  * games are processed in strict chronological order, grouped by date;
  * features for every game on date D are computed from accumulated state that
    contains only games with ``game_date < D``;
  * that date's results are folded into the state *only after* all of its rows
    have been emitted.

Same-date games are therefore never inputs to one another — which is exactly the
``same_day_contamination`` condition the Self-Learning workflow gates on.

Features that cannot be sourced from historical schedule/boxscore data (weather,
market odds) are declared UNSOURCED rather than invented; they are recorded in
the artifact metadata so nobody mistakes an inert input for a trained signal.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from itertools import groupby
from typing import Protocol

from app.domain.prediction.features import FEATURE_NAMES
from app.infrastructure.data_sources.mlb_stats_api import (
    GameBoxscore,
    PitcherLine,
    ScheduleGame,
    TeamBattingLine,
)

# Features derivable from schedule/boxscore history alone.
DERIVED_FEATURES: frozenset[str] = frozenset(
    {
        "home_starter_era",
        "away_starter_era",
        "home_starter_whip",
        "away_starter_whip",
        "home_team_woba",
        "away_team_woba",
        "home_bullpen_era",
        "away_bullpen_era",
        "home_bullpen_rest_days",
        "away_bullpen_rest_days",
        "park_factor",
    }
)

# Features that need an external feed. They are only populated when the matching
# source is supplied to the builder; otherwise they stay None (never fabricated).
WEATHER_FEATURES: frozenset[str] = frozenset({"temp_f", "wind_mph"})
ODDS_FEATURES: frozenset[str] = frozenset({"implied_home_win_probability"})
EXTERNAL_FEATURES: frozenset[str] = WEATHER_FEATURES | ODDS_FEATURES

# Features with no source at all when only schedule/boxscore history is used.
UNSOURCED_FEATURES: tuple[str, ...] = tuple(
    name for name in FEATURE_NAMES if name not in DERIVED_FEATURES
)


def unsourced_features(*, weather: bool, odds: bool) -> tuple[str, ...]:
    """Features that will carry no signal given the supplied external sources."""

    sourced = set(DERIVED_FEATURES)
    if weather:
        sourced |= WEATHER_FEATURES
    if odds:
        sourced |= ODDS_FEATURES
    return tuple(name for name in FEATURE_NAMES if name not in sourced)

# Minimum sample sizes before a rolling statistic is considered meaningful.
MIN_PITCHER_INNINGS = 5.0
MIN_TEAM_GAMES = 5
MIN_BULLPEN_INNINGS = 10.0
MIN_VENUE_GAMES = 5

# Standard wOBA linear weights (FanGraphs-style, modern-era approximation).
_WOBA_WEIGHTS = {
    "bb": 0.69,
    "hbp": 0.72,
    "1b": 0.89,
    "2b": 1.27,
    "3b": 1.62,
    "hr": 2.10,
}


class BoxscoreLookup(Protocol):
    def __call__(self, game_pk: str) -> GameBoxscore | None: ...


class WeatherLookup(Protocol):
    """Returns ``(temp_f, wind_mph)`` for a venue on a date; None when unknown."""

    def __call__(
        self, game_date: date, venue_id: str | None
    ) -> tuple[float | None, float | None]: ...


class OddsLookup(Protocol):
    """Returns the vig-free pre-game implied home win probability, or None."""

    def __call__(
        self, game_date: date, home_team: str, away_team: str
    ) -> float | None: ...


@dataclass
class _PitcherState:
    innings: float = 0.0
    earned_runs: int = 0
    hits: int = 0
    walks: int = 0

    def era(self) -> float | None:
        if self.innings < MIN_PITCHER_INNINGS:
            return None
        return 9.0 * self.earned_runs / self.innings

    def whip(self) -> float | None:
        if self.innings < MIN_PITCHER_INNINGS:
            return None
        return (self.walks + self.hits) / self.innings


@dataclass
class _TeamState:
    games: int = 0
    last_game_date: date | None = None
    batting: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    bullpen_innings: float = 0.0
    bullpen_earned_runs: int = 0

    def woba(self) -> float | None:
        if self.games < MIN_TEAM_GAMES:
            return None
        b = self.batting
        denominator = (
            b["at_bats"] + b["walks"] - b["intentional_walks"] + b["sac_flies"] + b["hbp"]
        )
        if denominator <= 0:
            return None
        numerator = (
            _WOBA_WEIGHTS["bb"] * (b["walks"] - b["intentional_walks"])
            + _WOBA_WEIGHTS["hbp"] * b["hbp"]
            + _WOBA_WEIGHTS["1b"] * b["singles"]
            + _WOBA_WEIGHTS["2b"] * b["doubles"]
            + _WOBA_WEIGHTS["3b"] * b["triples"]
            + _WOBA_WEIGHTS["hr"] * b["home_runs"]
        )
        return numerator / denominator

    def bullpen_era(self) -> float | None:
        if self.bullpen_innings < MIN_BULLPEN_INNINGS:
            return None
        return 9.0 * self.bullpen_earned_runs / self.bullpen_innings


@dataclass
class DatasetRow:
    """One training example: as-of features plus the observed run targets."""

    game_pk: str
    game_date: str
    home_team: str
    away_team: str
    features: list[float | None]
    home_runs: int
    away_runs: int

    def to_json(self) -> dict:
        return {
            "game_pk": self.game_pk,
            "game_date": self.game_date,
            "home_team": self.home_team,
            "away_team": self.away_team,
            "features": self.features,
            "home_runs": self.home_runs,
            "away_runs": self.away_runs,
        }

    @classmethod
    def from_json(cls, data: dict) -> DatasetRow:
        return cls(
            game_pk=str(data["game_pk"]),
            game_date=str(data["game_date"]),
            home_team=str(data["home_team"]),
            away_team=str(data["away_team"]),
            features=list(data["features"]),
            home_runs=int(data["home_runs"]),
            away_runs=int(data["away_runs"]),
        )


class AsOfDatasetBuilder:
    """Builds leakage-safe training rows from chronologically ordered games."""

    def __init__(
        self,
        boxscore_lookup: BoxscoreLookup | None = None,
        weather_lookup: WeatherLookup | None = None,
        odds_lookup: OddsLookup | None = None,
    ) -> None:
        self._boxscore = boxscore_lookup
        self._weather = weather_lookup
        self._odds = odds_lookup
        self._pitchers: dict[str, _PitcherState] = defaultdict(_PitcherState)
        self._teams: dict[str, _TeamState] = defaultdict(_TeamState)
        self._venue_runs: dict[str, int] = defaultdict(int)
        self._venue_games: dict[str, int] = defaultdict(int)
        self._league_runs = 0
        self._league_games = 0

    def build(self, games: list[ScheduleGame]) -> list[DatasetRow]:
        """Emit one row per game, warming up state as history accumulates.

        Games are grouped by date so that same-date games can never inform one
        another. Rows whose features are entirely unavailable (cold start) are
        still emitted with ``None`` entries; the trainer decides how to treat them.
        """

        ordered = sorted(games, key=lambda g: (g.game_date, g.game_pk))
        rows: list[DatasetRow] = []

        for _, same_day in groupby(ordered, key=lambda g: g.game_date):
            day_games = list(same_day)
            # 1) Emit features for every game on this date using prior state only.
            for game in day_games:
                rows.append(self._row_for(game))
            # 2) Only now fold this date's results into the state.
            for game in day_games:
                self._absorb(game)

        return rows

    # -- feature computation (reads state; never mutates it) --------------- #

    def _row_for(self, game: ScheduleGame) -> DatasetRow:
        home = self._teams.get(game.home_team, _TeamState())
        away = self._teams.get(game.away_team, _TeamState())
        home_sp = self._pitchers.get(game.home_probable_pitcher_id or "", _PitcherState())
        away_sp = self._pitchers.get(game.away_probable_pitcher_id or "", _PitcherState())

        values: dict[str, float | None] = {
            "home_starter_era": home_sp.era(),
            "away_starter_era": away_sp.era(),
            "home_starter_whip": home_sp.whip(),
            "away_starter_whip": away_sp.whip(),
            "home_team_woba": home.woba(),
            "away_team_woba": away.woba(),
            "home_bullpen_era": home.bullpen_era(),
            "away_bullpen_era": away.bullpen_era(),
            "home_bullpen_rest_days": _rest_days(home.last_game_date, game.game_date),
            "away_bullpen_rest_days": _rest_days(away.last_game_date, game.game_date),
            "park_factor": self._park_factor(game.venue_id),
        }
        # External feeds. Both describe conditions/prices known BEFORE first pitch,
        # so they are inputs rather than leakage. Absent a source they stay None —
        # never invented. (See weather.py on observed-vs-forecast provenance.)
        temp_f = wind_mph = None
        if self._weather is not None:
            temp_f, wind_mph = self._weather(game.game_date, game.venue_id)
        values["temp_f"] = temp_f
        values["wind_mph"] = wind_mph

        values["implied_home_win_probability"] = (
            self._odds(game.game_date, game.home_team, game.away_team)
            if self._odds is not None
            else None
        )

        return DatasetRow(
            game_pk=game.game_pk,
            game_date=game.game_date.isoformat(),
            home_team=game.home_team,
            away_team=game.away_team,
            features=[values[name] for name in FEATURE_NAMES],
            home_runs=game.home_runs,
            away_runs=game.away_runs,
        )

    def _park_factor(self, venue_id: str | None) -> float | None:
        if venue_id is None or self._venue_games[venue_id] < MIN_VENUE_GAMES:
            return None
        if self._league_games <= 0:
            return None
        league_rate = self._league_runs / self._league_games
        if league_rate <= 0:
            return None
        venue_rate = self._venue_runs[venue_id] / self._venue_games[venue_id]
        return venue_rate / league_rate

    # -- state update (called only after rows for the date are emitted) ---- #

    def _absorb(self, game: ScheduleGame) -> None:
        total_runs = game.home_runs + game.away_runs
        if game.venue_id is not None:
            self._venue_runs[game.venue_id] += total_runs
            self._venue_games[game.venue_id] += 1
        self._league_runs += total_runs
        self._league_games += 1

        box = self._boxscore(game.game_pk) if self._boxscore else None

        for team, batting, pitchers in (
            (game.home_team, box.home_batting if box else None, box.home_pitchers if box else ()),
            (game.away_team, box.away_batting if box else None, box.away_pitchers if box else ()),
        ):
            state = self._teams[team]
            state.games += 1
            state.last_game_date = game.game_date
            if batting is not None:
                _accumulate_batting(state.batting, batting)
            for line in pitchers:
                pitcher = self._pitchers[line.pitcher_id]
                pitcher.innings += line.innings_pitched
                pitcher.earned_runs += line.earned_runs
                pitcher.hits += line.hits_allowed
                pitcher.walks += line.walks_allowed
                if not line.is_starter:
                    state.bullpen_innings += line.innings_pitched
                    state.bullpen_earned_runs += line.earned_runs


def _accumulate_batting(target: dict[str, int], line: TeamBattingLine) -> None:
    target["at_bats"] += line.at_bats
    target["hits"] += line.hits
    target["doubles"] += line.doubles
    target["triples"] += line.triples
    target["home_runs"] += line.home_runs
    target["walks"] += line.walks
    target["intentional_walks"] += line.intentional_walks
    target["hbp"] += line.hit_by_pitch
    target["sac_flies"] += line.sac_flies
    target["singles"] += line.singles


def _rest_days(last_game: date | None, current: date) -> float | None:
    if last_game is None:
        return None
    return float((current - last_game).days)


def starter_from(pitchers: tuple[PitcherLine, ...]) -> PitcherLine | None:
    for line in pitchers:
        if line.is_starter:
            return line
    return None
