"""Thin, real client for the public MLB Stats API.

This is genuine ingestion code: the URLs and response parsing target the live
``statsapi.mlb.com`` service (public, no key). It is exercised by the live slate
provider when ``use_fixtures`` is False. In this sandbox the egress policy blocks
that host, so the pipeline defaults to fixtures — but the moment this runs where
the host is reachable, ``schedule()`` returns real games.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any


class MlbStatsClient:
    def __init__(self, base_url: str = "https://statsapi.mlb.com/api/v1", timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        query = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in params.items())
        url = f"{self.base_url}/{path.lstrip('/')}?{query}"
        # urllib honors HTTPS_PROXY via the environment's ProxyHandler by default.
        with urllib.request.urlopen(url, timeout=self.timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))

    def schedule(self, date: str) -> list[dict[str, Any]]:
        """Return the day's games (date as YYYY-MM-DD).

        Parses the standard ``/schedule`` response into a compact list of
        ``{gamePk, startTimeUtc, home, away}`` records. Probable pitchers and
        team stats are separate endpoints; the live slate provider joins them.
        """
        payload = self._get("schedule", {"sportId": 1, "date": date, "hydrate": "probablePitcher"})
        games: list[dict[str, Any]] = []
        for day in payload.get("dates", []):
            for game in day.get("games", []):
                teams = game.get("teams", {})
                home = teams.get("home", {}).get("team", {})
                away = teams.get("away", {}).get("team", {})
                games.append(
                    {
                        "gamePk": game.get("gamePk"),
                        "startTimeUtc": game.get("gameDate"),
                        "home": {"id": home.get("id"), "name": home.get("name")},
                        "away": {"id": away.get("id"), "name": away.get("name")},
                        "homeProbablePitcherId": teams.get("home", {})
                        .get("probablePitcher", {})
                        .get("id"),
                        "awayProbablePitcherId": teams.get("away", {})
                        .get("probablePitcher", {})
                        .get("id"),
                    }
                )
        return games
