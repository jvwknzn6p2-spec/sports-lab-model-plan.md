"""Live MLB Stats API feed for **daily prediction** (upcoming games).

Where :mod:`app.infrastructure.data_sources.mlb_stats_api` serves the historical
material for training (completed games + boxscores), this module serves the
forward-looking slate needed to predict *today's* games: the schedule with
probable starters, each starter's season ERA/WHIP, and each team's season
hitting line (for wOBA). It reuses that module's transport so tests inject
recorded fixtures and run with no network.

All parsers are pure functions over decoded JSON and never fabricate a missing
value — an absent probable pitcher or season line comes back as ``None`` so the
feature-engineering layer can flag it (never invent a league-average arm).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from app.core.logging import get_logger
from app.domain.feature_engineering import sabermetrics
from app.infrastructure.data_sources.mlb_stats_api import (
    BASE_URL,
    SPORT_ID_MLB,
    HttpxTransport,
    JsonTransport,
    _innings_to_float,
    _opt_str,
)

logger = get_logger("mlb_live")

# Abstract/detailed states we must NOT predict on.
_FINISHED_OR_DEAD = {"Final", "Game Over", "Completed Early", "Postponed", "Cancelled"}


@dataclass(frozen=True)
class SlateStarter:
    pitcher_id: str | None
    name: str | None

    @property
    def confirmed(self) -> bool:
        # The schedule endpoint lists a "probable" pitcher; treat a present id as
        # projected-but-known. True confirmation comes from the lineup feed, which
        # the daily service applies separately when available.
        return self.pitcher_id is not None


@dataclass(frozen=True)
class SlateGame:
    game_pk: str
    game_date: date
    scheduled_start: datetime | None
    status: str
    home_team: str
    away_team: str
    home_team_id: str | None
    away_team_id: str | None
    venue_id: str | None
    venue_name: str | None
    home_starter: SlateStarter
    away_starter: SlateStarter


@dataclass(frozen=True)
class PitcherSeason:
    pitcher_id: str
    name: str | None
    era: float | None
    whip: float | None
    innings_pitched: float
    games_started: int


@dataclass(frozen=True)
class TeamHittingSeason:
    team_id: str
    woba: float | None
    games: int


# --------------------------------------------------------------------------- #
# Pure parsers
# --------------------------------------------------------------------------- #


def parse_slate(payload: dict[str, Any]) -> list[SlateGame]:
    """Parse a ``/schedule`` response into predictable (not-yet-final) games."""

    games: list[SlateGame] = []
    for day in payload.get("dates") or []:
        day_date = _date(day.get("date"))
        for raw in day.get("games") or []:
            status = ((raw.get("status") or {}).get("detailedState")) or ""
            abstract = ((raw.get("status") or {}).get("abstractGameState")) or ""
            if status in _FINISHED_OR_DEAD or abstract == "Final":
                continue

            teams = raw.get("teams") or {}
            home = teams.get("home") or {}
            away = teams.get("away") or {}
            game_date = _date(raw.get("officialDate")) or day_date
            if game_date is None:
                continue

            games.append(
                SlateGame(
                    game_pk=str(raw.get("gamePk")),
                    game_date=game_date,
                    scheduled_start=_datetime(raw.get("gameDate")),
                    status=status or abstract or "Scheduled",
                    home_team=_team_name(home),
                    away_team=_team_name(away),
                    home_team_id=_opt_str((home.get("team") or {}).get("id")),
                    away_team_id=_opt_str((away.get("team") or {}).get("id")),
                    venue_id=_opt_str((raw.get("venue") or {}).get("id")),
                    venue_name=_opt_str((raw.get("venue") or {}).get("name")),
                    home_starter=_starter(home),
                    away_starter=_starter(away),
                )
            )
    games.sort(key=lambda g: (g.game_date, g.game_pk))
    return games


def parse_pitcher_seasons(payload: dict[str, Any]) -> dict[str, PitcherSeason]:
    """Parse a ``/people?hydrate=stats(...season...)`` response, keyed by id."""

    out: dict[str, PitcherSeason] = {}
    for person in payload.get("people") or []:
        pid = _opt_str(person.get("id"))
        if pid is None:
            continue
        stat = _first_season_stat(person.get("stats"))
        if stat is None:
            out[pid] = PitcherSeason(pid, person.get("fullName"), None, None, 0.0, 0)
            continue
        ip = _innings_to_float(stat.get("inningsPitched")) or 0.0
        out[pid] = PitcherSeason(
            pitcher_id=pid,
            name=person.get("fullName"),
            era=_num(stat.get("era")),
            whip=_num(stat.get("whip")),
            innings_pitched=ip,
            games_started=int(_num(stat.get("gamesStarted")) or 0),
        )
    return out


def parse_team_hitting(payload: dict[str, Any], team_id: str) -> TeamHittingSeason:
    """Parse a ``/teams/{id}/stats?group=hitting&stats=season`` response into wOBA."""

    stat = _first_season_stat(payload.get("stats"))
    if stat is None:
        return TeamHittingSeason(team_id, None, 0)
    hits = _int(stat.get("hits"))
    doubles = _int(stat.get("doubles"))
    triples = _int(stat.get("triples"))
    home_runs = _int(stat.get("homeRuns"))
    singles = max(hits - doubles - triples - home_runs, 0)
    value = sabermetrics.woba(
        at_bats=_int(stat.get("atBats")),
        walks=_int(stat.get("baseOnBalls")),
        intentional_walks=_int(stat.get("intentionalWalks")),
        hit_by_pitch=_int(stat.get("hitByPitch")),
        singles=singles,
        doubles=doubles,
        triples=triples,
        home_runs=home_runs,
        sac_flies=_int(stat.get("sacFlies")),
    )
    return TeamHittingSeason(team_id, value, _int(stat.get("gamesPlayed")))


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _starter(side: dict[str, Any]) -> SlateStarter:
    probable = side.get("probablePitcher") or {}
    return SlateStarter(
        pitcher_id=_opt_str(probable.get("id")), name=probable.get("fullName")
    )


def _first_season_stat(stats: Any) -> dict[str, Any] | None:
    if not isinstance(stats, list):
        return None
    for group in stats:
        for split in (group or {}).get("splits") or []:
            stat = (split or {}).get("stat")
            if isinstance(stat, dict) and stat:
                return stat
    return None


def _team_name(side: dict[str, Any]) -> str:
    team = side.get("team") or {}
    return str(team.get("name") or team.get("id") or "UNKNOWN")


def _date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def _datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int:
    try:
        return int(float(value)) if value is not None else 0
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------------- #
# Feed
# --------------------------------------------------------------------------- #


class MlbLiveFeed:
    """Slate + season-stats feed for daily prediction (transport-injected)."""

    def __init__(
        self,
        transport: JsonTransport | None = None,
        base_url: str = BASE_URL,
        cache_dir: str | Path | None = None,
    ) -> None:
        self._transport = transport or HttpxTransport()
        self._base_url = base_url
        self._cache = Path(cache_dir) if cache_dir else None
        if self._cache:
            self._cache.mkdir(parents=True, exist_ok=True)

    def fetch_slate(self, target_date: date) -> list[SlateGame]:
        payload = self._get(
            f"slate_{target_date.isoformat()}.json",
            f"{self._base_url}/schedule",
            {
                "sportId": SPORT_ID_MLB,
                "date": target_date.isoformat(),
                "hydrate": "probablePitcher,team,venue,linescore",
            },
        )
        return parse_slate(payload)

    def fetch_pitcher_seasons(
        self, pitcher_ids: list[str], season: int
    ) -> dict[str, PitcherSeason]:
        ids = sorted({p for p in pitcher_ids if p})
        if not ids:
            return {}
        payload = self._get(
            f"pitchers_{season}_{'_'.join(ids)}.json",
            f"{self._base_url}/people",
            {
                "personIds": ",".join(ids),
                "hydrate": f"stats(group=[pitching],type=[season],season={season},gameType=[R])",
            },
        )
        return parse_pitcher_seasons(payload)

    def fetch_team_hitting(self, team_id: str, season: int) -> TeamHittingSeason:
        payload = self._get(
            f"team_hitting_{season}_{team_id}.json",
            f"{self._base_url}/teams/{team_id}/stats",
            {"stats": "season", "group": "hitting", "season": season},
        )
        return parse_team_hitting(payload, team_id)

    def _get(
        self, filename: str, url: str, params: dict[str, Any] | None
    ) -> dict[str, Any]:
        if self._cache is not None:
            path = self._cache / filename
            if path.exists():
                import json

                return json.loads(path.read_text(encoding="utf-8"))
        payload = self._transport.get_json(url, params)
        if self._cache is not None:
            import json

            (self._cache / filename).write_text(json.dumps(payload), encoding="utf-8")
        return payload
