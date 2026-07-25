"""MLB Stats API data source (public endpoints, no authentication).

Provides the historical raw material for training: the schedule (with linescore
and probable pitchers) and per-game boxscores. Responses are cached to disk so a
dataset build is repeatable, reviewable, and re-runnable without re-hitting the
API — and so training can later run fully offline.

Parsing is separated from transport (``parse_schedule`` / ``parse_boxscore`` are
pure functions over decoded JSON) so it is unit-tested against recorded fixtures
without any network access.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Protocol

from app.core.logging import get_logger

logger = get_logger("mlb_stats_api")

BASE_URL = "https://statsapi.mlb.com/api/v1"
SPORT_ID_MLB = 1

# Statuses that represent a completed, scoreable game.
_FINAL_STATES = {"Final", "Game Over", "Completed Early"}


@dataclass(frozen=True)
class PitcherLine:
    """A single pitcher's line from a boxscore."""

    pitcher_id: str
    innings_pitched: float
    earned_runs: int
    hits_allowed: int
    walks_allowed: int
    is_starter: bool


@dataclass(frozen=True)
class TeamBattingLine:
    """A team's batting totals from a boxscore (used for as-of wOBA)."""

    at_bats: int = 0
    hits: int = 0
    doubles: int = 0
    triples: int = 0
    home_runs: int = 0
    walks: int = 0
    intentional_walks: int = 0
    hit_by_pitch: int = 0
    sac_flies: int = 0

    @property
    def singles(self) -> int:
        return max(self.hits - self.doubles - self.triples - self.home_runs, 0)


@dataclass(frozen=True)
class GameBoxscore:
    game_pk: str
    home_pitchers: tuple[PitcherLine, ...] = ()
    away_pitchers: tuple[PitcherLine, ...] = ()
    home_batting: TeamBattingLine = field(default_factory=TeamBattingLine)
    away_batting: TeamBattingLine = field(default_factory=TeamBattingLine)


@dataclass(frozen=True)
class ScheduleGame:
    """A completed game as reported by the schedule endpoint."""

    game_pk: str
    game_date: date
    home_team: str
    away_team: str
    home_runs: int
    away_runs: int
    # Regulation-nine runs (from the linescore innings). None when the linescore
    # is unavailable. Required for the NPB_REG9_ONLY settlement scope and useful
    # for distinguishing extra-innings outcomes in MLB.
    home_runs_reg9: int | None
    away_runs_reg9: int | None
    innings_played: int | None
    venue_id: str | None
    home_probable_pitcher_id: str | None
    away_probable_pitcher_id: str | None

    @property
    def went_extra_innings(self) -> bool:
        return bool(self.innings_played and self.innings_played > 9)


# --------------------------------------------------------------------------- #
# Pure parsers (unit-tested against recorded fixtures; no network)
# --------------------------------------------------------------------------- #


def parse_schedule(payload: dict[str, Any]) -> list[ScheduleGame]:
    """Parse a ``/schedule`` response into completed games, oldest first.

    Non-final games (postponed, in-progress, cancelled) are skipped: training and
    settlement must never consume an unfinished result.
    """

    games: list[ScheduleGame] = []
    for day in payload.get("dates") or []:
        for raw in day.get("games") or []:
            state = ((raw.get("status") or {}).get("detailedState")) or ""
            if state not in _FINAL_STATES:
                continue

            teams = raw.get("teams") or {}
            home = teams.get("home") or {}
            away = teams.get("away") or {}
            home_score = home.get("score")
            away_score = away.get("score")
            if home_score is None or away_score is None:
                continue

            game_date = _parse_game_date(raw, day)
            if game_date is None:
                continue

            reg9 = _regulation_nine(raw.get("linescore") or {})
            innings = (raw.get("linescore") or {}).get("currentInning")

            games.append(
                ScheduleGame(
                    game_pk=str(raw.get("gamePk")),
                    game_date=game_date,
                    home_team=_team_name(home),
                    away_team=_team_name(away),
                    home_runs=int(home_score),
                    away_runs=int(away_score),
                    home_runs_reg9=reg9[0],
                    away_runs_reg9=reg9[1],
                    innings_played=int(innings) if innings is not None else None,
                    venue_id=_opt_str((raw.get("venue") or {}).get("id")),
                    home_probable_pitcher_id=_opt_str(
                        (home.get("probablePitcher") or {}).get("id")
                    ),
                    away_probable_pitcher_id=_opt_str(
                        (away.get("probablePitcher") or {}).get("id")
                    ),
                )
            )

    games.sort(key=lambda g: (g.game_date, g.game_pk))
    return games


def parse_boxscore(payload: dict[str, Any], game_pk: str) -> GameBoxscore:
    """Parse a ``/game/{gamePk}/boxscore`` response."""

    teams = payload.get("teams") or {}
    return GameBoxscore(
        game_pk=game_pk,
        home_pitchers=_pitcher_lines(teams.get("home") or {}),
        away_pitchers=_pitcher_lines(teams.get("away") or {}),
        home_batting=_batting_line(teams.get("home") or {}),
        away_batting=_batting_line(teams.get("away") or {}),
    )


def _regulation_nine(linescore: dict[str, Any]) -> tuple[int | None, int | None]:
    """Sum runs over the first nine innings only (regulation)."""

    innings = linescore.get("innings")
    if not innings:
        return None, None
    home_total = 0
    away_total = 0
    for inning in innings[:9]:
        home_total += int(((inning.get("home") or {}).get("runs")) or 0)
        away_total += int(((inning.get("away") or {}).get("runs")) or 0)
    return home_total, away_total


def _pitcher_lines(team_block: dict[str, Any]) -> tuple[PitcherLine, ...]:
    players = team_block.get("players") or {}
    starters = set(team_block.get("pitchers") or [])
    first_pitcher = (team_block.get("pitchers") or [None])[0]
    lines: list[PitcherLine] = []
    for key, player in players.items():
        stats = ((player.get("stats") or {}).get("pitching")) or {}
        if not stats:
            continue
        pid = _opt_str((player.get("person") or {}).get("id")) or key.removeprefix("ID")
        ip = _innings_to_float(stats.get("inningsPitched"))
        if ip is None:
            continue
        lines.append(
            PitcherLine(
                pitcher_id=pid,
                innings_pitched=ip,
                earned_runs=int(stats.get("earnedRuns") or 0),
                hits_allowed=int(stats.get("hits") or 0),
                walks_allowed=int(stats.get("baseOnBalls") or 0),
                is_starter=(first_pitcher is not None and str(first_pitcher) == pid)
                or (str(stats.get("gamesStarted") or 0) == "1"),
            )
        )
    # Deterministic ordering: starter first, then by pitcher id.
    lines.sort(key=lambda p: (not p.is_starter, p.pitcher_id))
    _ = starters  # retained for clarity; ordering above is authoritative
    return tuple(lines)


def _batting_line(team_block: dict[str, Any]) -> TeamBattingLine:
    batting = ((team_block.get("teamStats") or {}).get("batting")) or {}
    if not batting:
        return TeamBattingLine()
    return TeamBattingLine(
        at_bats=int(batting.get("atBats") or 0),
        hits=int(batting.get("hits") or 0),
        doubles=int(batting.get("doubles") or 0),
        triples=int(batting.get("triples") or 0),
        home_runs=int(batting.get("homeRuns") or 0),
        walks=int(batting.get("baseOnBalls") or 0),
        intentional_walks=int(batting.get("intentionalWalks") or 0),
        hit_by_pitch=int(batting.get("hitByPitch") or 0),
        sac_flies=int(batting.get("sacFlies") or 0),
    )


def _innings_to_float(value: Any) -> float | None:
    """MLB reports innings as '6.2' meaning 6 and 2/3 innings."""

    if value is None:
        return None
    text = str(value)
    try:
        whole_str, _, frac_str = text.partition(".")
        whole = int(whole_str or 0)
        outs = int(frac_str[0]) if frac_str else 0
        if outs not in (0, 1, 2):
            return float(text)
        return whole + outs / 3.0
    except ValueError:
        return None


def _team_name(side: dict[str, Any]) -> str:
    team = side.get("team") or {}
    return str(team.get("name") or team.get("id") or "UNKNOWN")


def _parse_game_date(raw: dict[str, Any], day: dict[str, Any]) -> date | None:
    official = raw.get("officialDate") or day.get("date")
    if official:
        try:
            return date.fromisoformat(str(official))
        except ValueError:
            pass
    game_date = raw.get("gameDate")
    if game_date:
        try:
            return datetime.fromisoformat(str(game_date).replace("Z", "+00:00")).date()
        except ValueError:
            return None
    return None


def _opt_str(value: Any) -> str | None:
    return None if value is None else str(value)


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #


class JsonTransport(Protocol):
    """Fetches and decodes JSON for a URL (injected so tests need no network)."""

    def get_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]: ...


class HttpxTransport:
    """Real HTTP transport with bounded timeouts and retries."""

    def __init__(self, timeout_seconds: float = 20.0, max_attempts: int = 3) -> None:
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts

    def get_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        import httpx

        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = httpx.get(url, params=params, timeout=self._timeout)
                response.raise_for_status()
                return response.json()
            except Exception as exc:  # noqa: BLE001 - re-raised after retries
                last_error = exc
                logger.warning(
                    "mlb_api_request_failed", url=url, attempt=attempt, error=str(exc)
                )
        raise RuntimeError(f"MLB Stats API request failed after retries: {url}") from last_error


class MlbStatsApiFeed:
    """Schedule + boxscore feed with an on-disk response cache."""

    def __init__(
        self,
        cache_dir: str | Path,
        transport: JsonTransport | None = None,
        base_url: str = BASE_URL,
    ) -> None:
        self._cache = Path(cache_dir)
        self._cache.mkdir(parents=True, exist_ok=True)
        self._transport = transport or HttpxTransport()
        self._base_url = base_url

    def fetch_schedule(self, start: date, end: date) -> list[ScheduleGame]:
        payload = self._cached(
            f"schedule_{start.isoformat()}_{end.isoformat()}.json",
            f"{self._base_url}/schedule",
            {
                "sportId": SPORT_ID_MLB,
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
                "hydrate": "probablePitcher,linescore",
            },
        )
        return parse_schedule(payload)

    def fetch_boxscore(self, game_pk: str) -> GameBoxscore:
        payload = self._cached(
            f"boxscore_{game_pk}.json",
            f"{self._base_url}/game/{game_pk}/boxscore",
            None,
        )
        return parse_boxscore(payload, game_pk)

    def _cached(
        self, filename: str, url: str, params: dict[str, Any] | None
    ) -> dict[str, Any]:
        path = self._cache / filename
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        payload = self._transport.get_json(url, params)
        path.write_text(json.dumps(payload), encoding="utf-8")
        return payload
