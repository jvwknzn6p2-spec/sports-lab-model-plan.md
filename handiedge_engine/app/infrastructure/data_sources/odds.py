"""Historical odds source — supplies ``implied_home_win_probability``.

There is no free public feed of historical closing odds, so this module provides
the *math* plus two pluggable sources:

  * :class:`CsvOddsHistory` — a user-supplied export (CSV/JSONL) of closing
    moneylines. This is the recommended path: bring your own licensed data.
  * :class:`TheOddsApiHistory` — adapter for The Odds API historical endpoint,
    which requires a paid API key supplied via the environment.

Only **pre-game** prices may be used (closing line is the standard choice); using
a live in-game price would be look-ahead leakage.

The implied probability is always **vig-free**: raw book probabilities sum to
more than 1, and feeding that raw number to a model would bake the bookmaker's
margin into the feature.
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Protocol

from app.core.logging import get_logger

logger = get_logger("odds_history")


def american_to_probability(odds: float) -> float:
    """Convert American moneyline odds to a raw implied probability."""

    if odds == 0:
        raise ValueError("American odds cannot be zero")
    if odds < 0:
        return (-odds) / ((-odds) + 100.0)
    return 100.0 / (odds + 100.0)


def decimal_to_probability(odds: float) -> float:
    """Convert decimal odds to a raw implied probability."""

    if odds <= 1.0:
        raise ValueError("decimal odds must be greater than 1.0")
    return 1.0 / odds


def devig(home_prob: float, away_prob: float) -> float:
    """Remove the bookmaker margin, returning the normalized home probability."""

    total = home_prob + away_prob
    if total <= 0:
        raise ValueError("implied probabilities must be positive")
    return home_prob / total


def implied_home_probability(
    home_odds: float, away_odds: float, style: str = "american"
) -> float:
    """Vig-free implied home win probability from a two-way moneyline."""

    convert = american_to_probability if style == "american" else decimal_to_probability
    return devig(convert(home_odds), convert(away_odds))


@dataclass(frozen=True)
class OddsRecord:
    game_date: date
    home_team: str
    away_team: str
    implied_home_win_probability: float


class OddsHistorySource(Protocol):
    def lookup(
        self, game_date: date, home_team: str, away_team: str
    ) -> float | None: ...


def _key(game_date: date, home_team: str, away_team: str) -> tuple[str, str, str]:
    return (game_date.isoformat(), home_team.strip().lower(), away_team.strip().lower())


class CsvOddsHistory:
    """Closing moneylines from a user-supplied CSV or JSONL export.

    Expected columns (CSV header or JSONL keys)::

        game_date,home_team,away_team,home_odds,away_odds[,odds_style]

    ``odds_style`` is ``american`` (default) or ``decimal``. Alternatively supply a
    ready-made ``implied_home_win_probability`` column and the odds columns may be
    omitted.
    """

    def __init__(self, path: str | Path) -> None:
        self._records: dict[tuple[str, str, str], float] = {}
        self._load(Path(path))

    def _load(self, path: Path) -> None:
        if not path.exists():
            raise FileNotFoundError(f"odds history file not found: {path}")
        rows = (
            self._read_jsonl(path)
            if path.suffix.lower() in {".jsonl", ".ndjson"}
            else self._read_csv(path)
        )
        skipped = 0
        for row in rows:
            try:
                record = self._to_record(row)
            except (KeyError, ValueError) as exc:
                skipped += 1
                logger.warning("odds_row_skipped", error=str(exc))
                continue
            self._records[
                _key(record.game_date, record.home_team, record.away_team)
            ] = record.implied_home_win_probability
        logger.info("odds_history_loaded", records=len(self._records), skipped=skipped)

    @staticmethod
    def _read_csv(path: Path) -> list[dict]:
        with path.open(newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict]:
        rows = []
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        return rows

    @staticmethod
    def _to_record(row: dict) -> OddsRecord:
        game_date = date.fromisoformat(str(row["game_date"]).strip())
        home = str(row["home_team"]).strip()
        away = str(row["away_team"]).strip()

        ready = row.get("implied_home_win_probability")
        if ready not in (None, ""):
            probability = float(ready)
            if not 0.0 < probability < 1.0:
                raise ValueError(f"implied probability out of range: {probability}")
        else:
            style = str(row.get("odds_style") or "american").strip().lower()
            probability = implied_home_probability(
                float(row["home_odds"]), float(row["away_odds"]), style=style
            )
        return OddsRecord(game_date, home, away, probability)

    def lookup(self, game_date: date, home_team: str, away_team: str) -> float | None:
        return self._records.get(_key(game_date, home_team, away_team))

    def __len__(self) -> int:
        return len(self._records)


class TheOddsApiHistory:
    """Adapter for The Odds API historical endpoint (paid key required).

    The key is read from the ``ODDS_API_KEY`` environment variable — never
    committed and never passed on the command line.
    """

    BASE_URL = "https://api.the-odds-api.com/v4"

    def __init__(
        self,
        cache_dir: str | Path,
        api_key: str | None = None,
        sport: str = "baseball_mlb",
        transport=None,
    ) -> None:
        self._api_key = api_key or os.environ.get("ODDS_API_KEY")
        if not self._api_key:
            raise ValueError(
                "TheOddsApiHistory requires an API key (set ODDS_API_KEY)"
            )
        self._cache = Path(cache_dir)
        self._cache.mkdir(parents=True, exist_ok=True)
        self._sport = sport
        if transport is None:
            from app.infrastructure.data_sources.mlb_stats_api import HttpxTransport

            transport = HttpxTransport()
        self._transport = transport
        self._by_date: dict[str, dict[tuple[str, str, str], float]] = {}

    def lookup(self, game_date: date, home_team: str, away_team: str) -> float | None:
        day = game_date.isoformat()
        if day not in self._by_date:
            self._by_date[day] = self._load_day(game_date)
        return self._by_date[day].get(_key(game_date, home_team, away_team))

    def _load_day(self, game_date: date) -> dict[tuple[str, str, str], float]:
        path = self._cache / f"odds_{game_date.isoformat()}.json"
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
        else:
            payload = self._transport.get_json(
                f"{self.BASE_URL}/historical/sports/{self._sport}/odds",
                {
                    "apiKey": self._api_key,
                    "regions": "us",
                    "markets": "h2h",
                    "oddsFormat": "decimal",
                    # Snapshot just before first pitch: pre-game only.
                    "date": f"{game_date.isoformat()}T16:00:00Z",
                },
            )
            path.write_text(json.dumps(payload), encoding="utf-8")
        return parse_the_odds_api(payload)


def parse_the_odds_api(payload: dict) -> dict[tuple[str, str, str], float]:
    """Parse a The Odds API historical snapshot into vig-free home probabilities."""

    events = payload.get("data") if isinstance(payload.get("data"), list) else payload
    if not isinstance(events, list):
        return {}

    result: dict[tuple[str, str, str], float] = {}
    for event in events:
        home = event.get("home_team")
        away = event.get("away_team")
        commence = event.get("commence_time")
        if not (home and away and commence):
            continue
        try:
            game_date = date.fromisoformat(str(commence)[:10])
        except ValueError:
            continue

        prices: list[tuple[float, float]] = []
        for book in event.get("bookmakers") or []:
            for market in book.get("markets") or []:
                if market.get("key") != "h2h":
                    continue
                outcomes = {o.get("name"): o.get("price") for o in market.get("outcomes") or []}
                if outcomes.get(home) and outcomes.get(away):
                    prices.append((float(outcomes[home]), float(outcomes[away])))

        if not prices:
            continue
        # Average the vig-free probability across books for stability.
        probs = [
            implied_home_probability(h, a, style="decimal") for h, a in prices
        ]
        result[_key(game_date, str(home), str(away))] = sum(probs) / len(probs)
    return result
