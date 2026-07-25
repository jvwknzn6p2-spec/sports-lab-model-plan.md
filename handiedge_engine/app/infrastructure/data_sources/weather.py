"""Historical weather source — supplies ``temp_f`` and ``wind_mph``.

Uses the Open-Meteo **archive** API (free, no authentication) to retrieve the
hourly conditions at a ballpark's coordinates, and takes the reading closest to
first pitch. Venue coordinates come from the MLB Stats API ``/venues`` endpoint.
Responses are cached to disk so a dataset build is repeatable offline.

INTEGRITY NOTE — observed vs forecast
-------------------------------------
This returns the **observed** conditions at game time. In live operation the
engine only has a *forecast* at prediction time, so training on observed weather
is a mild optimistic assumption (the model sees slightly better information than
it will at inference). It is a common and accepted practice in baseball modelling,
but it is an assumption, not a free lunch: it is recorded in the dataset manifest
as ``weather_mode: observed`` so the provenance is auditable. To eliminate it
entirely, source archived *forecasts* instead and set ``weather_mode: forecast``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Protocol

from app.core.logging import get_logger

logger = get_logger("weather_history")

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
MLB_VENUES_URL = "https://statsapi.mlb.com/api/v1/venues"

# Local first-pitch hours are unknown from the archive alone; 19:00 local is the
# canonical evening start and is used when no explicit hour is supplied.
DEFAULT_FIRST_PITCH_HOUR = 19


@dataclass(frozen=True)
class WeatherObservation:
    temp_f: float | None
    wind_mph: float | None


@dataclass(frozen=True)
class VenueLocation:
    venue_id: str
    latitude: float
    longitude: float
    name: str | None = None


class WeatherHistorySource(Protocol):
    def lookup(
        self, game_date: date, venue_id: str | None
    ) -> WeatherObservation: ...


# --------------------------------------------------------------------------- #
# Pure parsers (fixture-tested, no network)
# --------------------------------------------------------------------------- #


def parse_venue_locations(payload: dict[str, Any]) -> dict[str, VenueLocation]:
    """Parse an MLB ``/venues?hydrate=location`` response into a coordinate map."""

    locations: dict[str, VenueLocation] = {}
    for venue in payload.get("venues") or []:
        coordinates = ((venue.get("location") or {}).get("defaultCoordinates")) or {}
        latitude = coordinates.get("latitude")
        longitude = coordinates.get("longitude")
        venue_id = venue.get("id")
        if venue_id is None or latitude is None or longitude is None:
            continue
        locations[str(venue_id)] = VenueLocation(
            venue_id=str(venue_id),
            latitude=float(latitude),
            longitude=float(longitude),
            name=venue.get("name"),
        )
    return locations


def parse_hourly_archive(
    payload: dict[str, Any], target_hour: int = DEFAULT_FIRST_PITCH_HOUR
) -> dict[str, WeatherObservation]:
    """Parse an Open-Meteo hourly archive response into per-date observations.

    The reading nearest ``target_hour`` local time is selected for each date.
    """

    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []
    winds = hourly.get("wind_speed_10m") or []

    best: dict[str, tuple[int, WeatherObservation]] = {}
    for index, stamp in enumerate(times):
        try:
            moment = datetime.fromisoformat(str(stamp))
        except ValueError:
            continue
        day = moment.date().isoformat()
        distance = abs(moment.hour - target_hour)
        current = best.get(day)
        if current is not None and current[0] <= distance:
            continue
        best[day] = (
            distance,
            WeatherObservation(
                temp_f=_at(temps, index),
                wind_mph=_at(winds, index),
            ),
        )
    return {day: observation for day, (_, observation) in best.items()}


def _at(values: list[Any], index: int) -> float | None:
    if index >= len(values):
        return None
    value = values[index]
    return None if value is None else float(value)


# --------------------------------------------------------------------------- #
# Feed
# --------------------------------------------------------------------------- #


class OpenMeteoWeatherHistory:
    """Cached Open-Meteo archive lookup keyed by (venue, date)."""

    def __init__(
        self,
        cache_dir: str | Path,
        start: date,
        end: date,
        venue_locations: dict[str, VenueLocation] | None = None,
        transport=None,
        first_pitch_hour: int = DEFAULT_FIRST_PITCH_HOUR,
    ) -> None:
        self._cache = Path(cache_dir)
        self._cache.mkdir(parents=True, exist_ok=True)
        self._start = start
        self._end = end
        self._hour = first_pitch_hour
        if transport is None:
            from app.infrastructure.data_sources.mlb_stats_api import HttpxTransport

            transport = HttpxTransport()
        self._transport = transport
        self._venues = venue_locations if venue_locations is not None else self._load_venues()
        self._by_venue: dict[str, dict[str, WeatherObservation]] = {}

    def _load_venues(self) -> dict[str, VenueLocation]:
        path = self._cache / "mlb_venues.json"
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
        else:
            payload = self._transport.get_json(
                MLB_VENUES_URL, {"sportId": 1, "hydrate": "location"}
            )
            path.write_text(json.dumps(payload), encoding="utf-8")
        locations = parse_venue_locations(payload)
        logger.info("venue_locations_loaded", count=len(locations))
        return locations

    def lookup(self, game_date: date, venue_id: str | None) -> WeatherObservation:
        if venue_id is None or venue_id not in self._venues:
            return WeatherObservation(None, None)
        if venue_id not in self._by_venue:
            self._by_venue[venue_id] = self._load_venue_series(self._venues[venue_id])
        return self._by_venue[venue_id].get(
            game_date.isoformat(), WeatherObservation(None, None)
        )

    def _load_venue_series(self, venue: VenueLocation) -> dict[str, WeatherObservation]:
        path = (
            self._cache
            / f"weather_{venue.venue_id}_{self._start.isoformat()}_{self._end.isoformat()}.json"
        )
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
        else:
            payload = self._transport.get_json(
                ARCHIVE_URL,
                {
                    "latitude": venue.latitude,
                    "longitude": venue.longitude,
                    "start_date": self._start.isoformat(),
                    "end_date": self._end.isoformat(),
                    "hourly": "temperature_2m,wind_speed_10m",
                    # Request the units the feature contract expects directly.
                    "temperature_unit": "fahrenheit",
                    "wind_speed_unit": "mph",
                    "timezone": "auto",
                },
            )
            path.write_text(json.dumps(payload), encoding="utf-8")
        return parse_hourly_archive(payload, target_hour=self._hour)
