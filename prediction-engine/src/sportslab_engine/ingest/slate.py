"""Consolidated slate loading — the entry point to Steps 1–3 (data + validation).

A "slate" is the day's games with everything the model needs already joined:
schedule, confirmed starters and their lines, team/bullpen/form numbers, park
factor, weather, injuries, and market odds. Two providers produce it:

* the fixture provider (default here) reads a recorded JSON slate, and
* the live provider assembles one from the MLB Stats API plus odds/weather
  providers (wired to the real client; unblocked when egress allows it).

Both return the same ``dict`` shape, so nothing downstream knows or cares which
source was used.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..config import DEFAULT_CONFIG, EngineConfig
from .mlb_client import MlbStatsClient


def load_slate(date: str, config: EngineConfig = DEFAULT_CONFIG) -> list[dict[str, Any]]:
    """Load the consolidated slate for ``date`` (YYYY-MM-DD)."""
    if config.use_fixtures:
        return _load_fixture_slate(date, config)
    return _load_live_slate(date, config)


def _load_fixture_slate(date: str, config: EngineConfig) -> list[dict[str, Any]]:
    path = config.fixtures_dir / f"slate_{date}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"No fixture slate for {date} at {path}. "
            "Record one, or set SPORTSLAB_USE_FIXTURES=0 in an environment with "
            "egress to the data APIs."
        )
    games = json.loads(path.read_text(encoding="utf-8"))["games"]
    for game in games:
        _validate_slate_game(game)
    return games


def _load_live_slate(date: str, config: EngineConfig) -> list[dict[str, Any]]:
    """Assemble a slate from live sources.

    The MLB schedule + probable pitchers are fetched for real here. Advanced
    team stats, odds, and weather come from their own providers; those hooks are
    intentionally left as clearly-marked integration points so this build stays
    honest about what is and isn't wired to a live feed yet.
    """
    client = MlbStatsClient(base_url=config.mlb_base_url)
    schedule = client.schedule(date)
    # The join with stats/odds/weather providers is the remaining live-wiring
    # work (needs those providers' API keys / hosts). Until they're supplied,
    # fail loudly rather than emit half-populated games.
    raise NotImplementedError(
        f"Live slate assembly fetched {len(schedule)} games from MLB for {date}, "
        "but the odds/weather/advanced-stats providers are not yet wired. "
        "Use fixtures (SPORTSLAB_USE_FIXTURES=1) or supply those providers."
    )


def _validate_slate_game(game: dict[str, Any]) -> None:
    """Structural validation — Step 3's 'fail loudly, not silently' principle."""
    required = {"gameId", "startTimeLocal", "home", "away", "data", "features", "odds"}
    missing = required - set(game)
    if missing:
        raise ValueError(f"Slate game {game.get('gameId', '?')} missing keys: {sorted(missing)}")


def fixture_path(date: str, config: EngineConfig = DEFAULT_CONFIG) -> Path:
    return config.fixtures_dir / f"slate_{date}.json"
