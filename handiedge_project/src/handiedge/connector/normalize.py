"""Normalize raw OpticOdds connector payloads into typed records.

Robust to the documented real behaviour:
- an MLB fixture can come back with ``odds: []`` (normal — never crash/fabricate);
- NPB fixtures may omit starters / records / broadcast (fields stay ``None``);
- book timestamps arrive as numeric epoch (seconds or milliseconds);
- ``deep_link`` and sportsbook limits are dropped (volatile, never persisted).

Unmappable/garbage rows raise :class:`ValidationError` rather than being guessed.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..errors import ValidationError
from .models import Competitor, FixtureRecord, OddsSnapshotRow, ResultRecord

BASEBALL_MARKETS = frozenset({"moneyline", "run_line", "total_runs"})


def _epoch_to_utc(value: Any) -> datetime:
    ts = float(value)
    if ts > 1e12:  # milliseconds
        ts /= 1000.0
    return datetime.fromtimestamp(ts, tz=UTC)


def _iso_to_utc(value: Any) -> datetime:
    text = str(value).replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValidationError(f"fixture time is not timezone-aware: {value!r}")
    return dt.astimezone(UTC)


def _first(seq: Any) -> dict[str, Any] | None:
    if isinstance(seq, list) and seq and isinstance(seq[0], dict):
        return seq[0]
    if isinstance(seq, dict):
        return seq
    return None


def _competitor(raw: dict[str, Any], side: str) -> Competitor:
    comp = _first(raw.get(f"{side}_competitors")) or _first(raw.get(f"{side}_team")) or {}
    name = (
        comp.get("name")
        or raw.get(f"{side}_team_display")
        or raw.get(f"{side}_team")
        or comp.get("display")
    )
    team_id = comp.get("id") or raw.get(f"{side}_team_id")
    if not team_id or not name:
        raise ValidationError(f"fixture missing {side} competitor id/name")

    starter = _first(raw.get(f"{side}_starter")) or {}
    return Competitor(
        team_id=str(team_id),
        name=str(name),
        abbreviation=comp.get("abbreviation") or comp.get("abbr"),
        record=comp.get("record") or raw.get(f"{side}_record"),  # often None for NPB
        starter_id=(
            str(starter["id"]) if starter.get("id") is not None else raw.get(f"{side}_starter_id")
        ),
        starter_name=starter.get("name") or raw.get(f"{side}_starter_name"),
    )


def normalize_fixture(raw: dict[str, Any], *, league: str) -> FixtureRecord:
    fixture_id = raw.get("id") or raw.get("fixture_id")
    if not fixture_id:
        raise ValidationError("fixture missing canonical id")
    start_raw = raw.get("start_date") or raw.get("start_time") or raw.get("start")
    if start_raw is None:
        raise ValidationError("fixture missing start time")
    updated = raw.get("updated_at")
    return FixtureRecord(
        fixture_id=str(fixture_id),
        game_id=(str(raw["game_id"]) if raw.get("game_id") is not None else None),
        league=league,
        start_time=_iso_to_utc(start_raw),
        status=str(raw.get("status", "unknown")),
        is_live=bool(raw.get("is_live", False)),
        has_odds=bool(raw.get("has_odds", False)),
        home=_competitor(raw, "home"),
        away=_competitor(raw, "away"),
        venue=raw.get("venue_name") or raw.get("venue"),
        season_year=raw.get("season_year"),
        season_type=raw.get("season_type"),
        updated_at=_iso_to_utc(updated) if updated else None,
    )


def normalize_odds_fixture(
    raw: dict[str, Any], *, league: str, captured_at: datetime | None = None
) -> list[OddsSnapshotRow]:
    """Flatten one fixture's ``odds`` list into snapshot rows.

    ``odds: []`` (or missing) returns ``[]`` — a normal, non-error outcome.
    """
    captured = (captured_at or datetime.now(UTC)).astimezone(UTC)
    fixture_id = raw.get("id") or raw.get("fixture_id")
    if not fixture_id:
        raise ValidationError("odds fixture missing canonical id")
    rows: list[OddsSnapshotRow] = []
    for q in raw.get("odds") or []:
        if not isinstance(q, dict):
            raise ValidationError(f"odds entry is not an object: {q!r}")
        market_id = str(q.get("market_id") or q.get("market") or "").lower()
        if not market_id:
            raise ValidationError("odds entry missing market/market_id")
        try:
            price = float(q["price"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValidationError(f"odds entry has invalid decimal price: {exc}") from exc
        if price <= 1.0:
            raise ValidationError(f"decimal price must be > 1.0, got {price}")
        ts = q.get("timestamp")
        published = _epoch_to_utc(ts) if ts is not None else captured
        points = q.get("points")
        rows.append(
            OddsSnapshotRow(
                fixture_id=str(fixture_id),
                league=league,
                sportsbook=str(q.get("sportsbook", "unknown")),
                market_id=market_id,
                selection=str(q.get("selection") or q.get("name") or ""),
                normalized_selection=str(q.get("normalized_selection") or q.get("selection") or ""),
                price=price,
                points=(float(points) if points is not None else None),
                published_at=published,
                captured_at=captured,
                is_main=bool(q.get("is_main", True)),
                team_id=(str(q["team_id"]) if q.get("team_id") is not None else None),
                player_id=(str(q["player_id"]) if q.get("player_id") is not None else None),
                grouping_key=q.get("grouping_key"),
                # NOTE: deep_link and limits are intentionally dropped.
            )
        )
    return rows


def normalize_result(raw: dict[str, Any], *, league: str) -> ResultRecord:
    fixture_id = raw.get("id") or raw.get("fixture_id")
    if not fixture_id:
        raise ValidationError("result missing canonical fixture id")
    result_raw = raw.get("result")
    result: dict[str, Any] = result_raw if isinstance(result_raw, dict) else raw
    scores_raw = result.get("scores")
    scores: dict[str, Any] = scores_raw if isinstance(scores_raw, dict) else result
    home = _score(scores, "home")
    away = _score(scores, "away")
    status = str(raw.get("status") or result.get("status") or "pending").lower()
    is_final = status in {"completed", "final", "closed"}
    voided = status in {"cancelled", "canceled", "abandoned", "void"}
    return ResultRecord(
        fixture_id=str(fixture_id),
        league=league,
        home_score=home,
        away_score=away,
        status=status,
        is_final=is_final,
        voided=voided,
    )


def _score(obj: dict[str, Any], side: str) -> int | None:
    for key in (f"{side}_score", f"{side}_total", side):
        val = obj.get(key)
        if isinstance(val, dict):
            val = val.get("total") or val.get("score")
        if val is not None:
            try:
                return int(val)
            except (TypeError, ValueError):
                return None
    return None
