"""Weather and odds history sources (no network; fixtures and pure math)."""

from __future__ import annotations

import json
from datetime import date

import pytest

from app.domain.prediction.dataset import (
    DERIVED_FEATURES,
    ODDS_FEATURES,
    WEATHER_FEATURES,
    unsourced_features,
)
from app.infrastructure.data_sources.odds import (
    CsvOddsHistory,
    american_to_probability,
    decimal_to_probability,
    devig,
    implied_home_probability,
    parse_the_odds_api,
)
from app.infrastructure.data_sources.weather import (
    OpenMeteoWeatherHistory,
    VenueLocation,
    parse_hourly_archive,
    parse_venue_locations,
)

# --------------------------------------------------------------------------- #
# Odds math
# --------------------------------------------------------------------------- #


def test_american_odds_conversion():
    # -160 favorite implies 160/260 = 0.6154
    assert american_to_probability(-160) == pytest.approx(0.61538, abs=1e-4)
    # +140 underdog implies 100/240 = 0.4167
    assert american_to_probability(140) == pytest.approx(0.41667, abs=1e-4)


def test_decimal_odds_conversion():
    assert decimal_to_probability(2.0) == pytest.approx(0.5)
    assert decimal_to_probability(1.625) == pytest.approx(0.61538, abs=1e-4)


def test_zero_and_invalid_odds_rejected():
    with pytest.raises(ValueError):
        american_to_probability(0)
    with pytest.raises(ValueError):
        decimal_to_probability(1.0)


def test_devig_removes_bookmaker_margin():
    """Raw book probabilities sum above 1; the de-vigged value must sum to 1."""

    home_raw = american_to_probability(-160)
    away_raw = american_to_probability(140)
    assert home_raw + away_raw > 1.0  # the vig

    home = devig(home_raw, away_raw)
    away = devig(away_raw, home_raw)
    assert home + away == pytest.approx(1.0)
    assert home < home_raw  # margin stripped out


def test_implied_home_probability_end_to_end():
    probability = implied_home_probability(-160, 140, style="american")
    assert 0.0 < probability < 1.0
    assert probability == pytest.approx(0.5963, abs=1e-3)


def test_pickem_line_is_even():
    assert implied_home_probability(2.0, 2.0, style="decimal") == pytest.approx(0.5)


# --------------------------------------------------------------------------- #
# CSV odds source
# --------------------------------------------------------------------------- #


def _write_csv(tmp_path, body: str):
    path = tmp_path / "odds.csv"
    path.write_text(body, encoding="utf-8")
    return path


def test_csv_odds_history_lookup(tmp_path):
    path = _write_csv(
        tmp_path,
        "game_date,home_team,away_team,home_odds,away_odds\n"
        "2024-07-04,New York Yankees,Boston Red Sox,-160,140\n",
    )
    source = CsvOddsHistory(path)
    assert len(source) == 1
    value = source.lookup(date(2024, 7, 4), "New York Yankees", "Boston Red Sox")
    assert value == pytest.approx(0.5963, abs=1e-3)


def test_csv_odds_lookup_is_case_insensitive(tmp_path):
    path = _write_csv(
        tmp_path,
        "game_date,home_team,away_team,home_odds,away_odds\n"
        "2024-07-04,New York Yankees,Boston Red Sox,-160,140\n",
    )
    source = CsvOddsHistory(path)
    assert source.lookup(date(2024, 7, 4), "new york yankees", "BOSTON RED SOX") is not None


def test_csv_odds_missing_game_returns_none(tmp_path):
    path = _write_csv(
        tmp_path,
        "game_date,home_team,away_team,home_odds,away_odds\n"
        "2024-07-04,New York Yankees,Boston Red Sox,-160,140\n",
    )
    source = CsvOddsHistory(path)
    assert source.lookup(date(2024, 7, 5), "New York Yankees", "Boston Red Sox") is None


def test_csv_odds_accepts_precomputed_probability(tmp_path):
    path = _write_csv(
        tmp_path,
        "game_date,home_team,away_team,implied_home_win_probability\n"
        "2024-07-04,LAD,SF,0.62\n",
    )
    assert CsvOddsHistory(path).lookup(date(2024, 7, 4), "LAD", "SF") == pytest.approx(0.62)


def test_csv_odds_skips_malformed_rows_without_aborting(tmp_path):
    path = _write_csv(
        tmp_path,
        "game_date,home_team,away_team,home_odds,away_odds\n"
        "not-a-date,LAD,SF,-120,100\n"
        "2024-07-04,LAD,SF,-120,100\n",
    )
    source = CsvOddsHistory(path)
    assert len(source) == 1  # bad row skipped, good row kept


def test_csv_odds_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        CsvOddsHistory(tmp_path / "nope.csv")


def test_parse_the_odds_api_averages_books():
    payload = {
        "data": [
            {
                "home_team": "New York Yankees",
                "away_team": "Boston Red Sox",
                "commence_time": "2024-07-04T23:05:00Z",
                "bookmakers": [
                    {
                        "markets": [
                            {
                                "key": "h2h",
                                "outcomes": [
                                    {"name": "New York Yankees", "price": 1.6},
                                    {"name": "Boston Red Sox", "price": 2.4},
                                ],
                            }
                        ]
                    }
                ],
            }
        ]
    }
    parsed = parse_the_odds_api(payload)
    key = ("2024-07-04", "new york yankees", "boston red sox")
    assert key in parsed
    assert 0.5 < parsed[key] < 0.7


# --------------------------------------------------------------------------- #
# Weather
# --------------------------------------------------------------------------- #


def test_parse_venue_locations():
    payload = {
        "venues": [
            {
                "id": 3313,
                "name": "Yankee Stadium",
                "location": {"defaultCoordinates": {"latitude": 40.83, "longitude": -73.93}},
            },
            {"id": 999, "name": "No Coordinates"},
        ]
    }
    locations = parse_venue_locations(payload)
    assert set(locations) == {"3313"}  # venue without coordinates is skipped
    assert locations["3313"].latitude == pytest.approx(40.83)


def test_parse_hourly_archive_picks_reading_nearest_first_pitch():
    payload = {
        "hourly": {
            "time": ["2024-07-04T12:00", "2024-07-04T19:00", "2024-07-04T23:00"],
            "temperature_2m": [70.0, 78.0, 66.0],
            "wind_speed_10m": [3.0, 6.0, 9.0],
        }
    }
    parsed = parse_hourly_archive(payload, target_hour=19)
    observation = parsed["2024-07-04"]
    assert observation.temp_f == pytest.approx(78.0)
    assert observation.wind_mph == pytest.approx(6.0)


def test_parse_hourly_archive_handles_nulls():
    payload = {
        "hourly": {
            "time": ["2024-07-04T19:00"],
            "temperature_2m": [None],
            "wind_speed_10m": [5.0],
        }
    }
    observation = parse_hourly_archive(payload, target_hour=19)["2024-07-04"]
    assert observation.temp_f is None
    assert observation.wind_mph == pytest.approx(5.0)


class _StubTransport:
    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls = 0

    def get_json(self, url: str, params=None) -> dict:
        self.calls += 1
        return self.payload


def test_weather_history_lookup_and_cache(tmp_path):
    payload = {
        "hourly": {
            "time": ["2024-07-04T19:00", "2024-07-05T19:00"],
            "temperature_2m": [78.0, 81.0],
            "wind_speed_10m": [6.0, 4.0],
        }
    }
    transport = _StubTransport(payload)
    history = OpenMeteoWeatherHistory(
        cache_dir=tmp_path,
        start=date(2024, 7, 4),
        end=date(2024, 7, 5),
        venue_locations={"3313": VenueLocation("3313", 40.83, -73.93)},
        transport=transport,
    )

    first = history.lookup(date(2024, 7, 4), "3313")
    assert first.temp_f == pytest.approx(78.0)
    second = history.lookup(date(2024, 7, 5), "3313")
    assert second.temp_f == pytest.approx(81.0)
    assert transport.calls == 1  # one fetch covers the whole date range

    cached = list(tmp_path.glob("weather_3313_*.json"))
    assert len(cached) == 1
    assert json.loads(cached[0].read_text())["hourly"]["time"]


def test_weather_unknown_venue_returns_empty_observation(tmp_path):
    history = OpenMeteoWeatherHistory(
        cache_dir=tmp_path,
        start=date(2024, 7, 4),
        end=date(2024, 7, 5),
        venue_locations={},
        transport=_StubTransport({}),
    )
    observation = history.lookup(date(2024, 7, 4), "does-not-exist")
    assert observation.temp_f is None and observation.wind_mph is None


# --------------------------------------------------------------------------- #
# Sourcing declaration
# --------------------------------------------------------------------------- #


def test_unsourced_shrinks_as_sources_are_added():
    none_supplied = unsourced_features(weather=False, odds=False)
    assert set(none_supplied) == WEATHER_FEATURES | ODDS_FEATURES

    with_weather = unsourced_features(weather=True, odds=False)
    assert set(with_weather) == ODDS_FEATURES

    both = unsourced_features(weather=True, odds=True)
    assert both == ()


def test_derived_and_external_sets_are_disjoint():
    assert not (DERIVED_FEATURES & (WEATHER_FEATURES | ODDS_FEATURES))


def test_unsourced_must_be_measured_not_assumed():
    """Regression: provenance must reflect the actual data, not a static list.

    A dataset that genuinely supplies weather/odds must not be labelled as having
    those features inert — that would understate the model and mislead operators.
    """

    import numpy as np

    from app.domain.prediction.features import FEATURE_NAMES

    columns = len(FEATURE_NAMES)
    supplied = np.ones((10, columns), dtype="float32")
    measured = [
        FEATURE_NAMES[j]
        for j in range(columns)
        if np.isnan(np.nanmedian(supplied[:, j]))
    ]
    assert measured == []

    # Now blank out only the external columns; those — and only those — are inert.
    partial = supplied.copy()
    external = WEATHER_FEATURES | ODDS_FEATURES
    for name in external:
        partial[:, FEATURE_NAMES.index(name)] = np.nan
    with np.errstate(all="ignore"):
        measured = [
            FEATURE_NAMES[j]
            for j in range(columns)
            if np.isnan(np.nanmedian(partial[:, j]))
        ]
    assert set(measured) == external
