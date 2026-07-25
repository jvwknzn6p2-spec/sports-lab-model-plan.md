"""Ingestion services and league-namespaced local stores (audit category 4).

Persistence is a plain, dependency-free local data lake under ``data_dir``:
- ``raw/{league}/{kind}/{ts}.json`` — append-only, immutable connector envelopes
  captured verbatim (minus volatile deep links / limits, which the normalizer
  never carries into typed records). Raw files are never mutated or overwritten.
- ``normalized/{league}/{kind}.jsonl`` — typed records as JSON lines, keyed so a
  re-sync upserts by canonical id rather than duplicating.

The sync services take an :class:`OpticOddsConnector` and are fully async. They
enforce the connector's real limits: **US sportsbooks only**, **max five books per
odds batch**, moneyline/run_line/total_runs markets only. Nothing is fabricated —
a fixture with ``odds: []`` persists an empty (but real) snapshot set.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, is_dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..connector.external_tool import OpticOddsConnector
from ..connector.models import Competitor, FixtureRecord, OddsSnapshotRow, ResultRecord
from ..connector.normalize import (
    BASEBALL_MARKETS,
    normalize_fixture,
    normalize_odds_fixture,
    normalize_result,
)
from ..errors import ValidationError

MAX_SPORTSBOOKS_PER_BATCH = 5


def _json_default(obj: Any) -> Any:
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"not JSON-serializable: {type(obj).__name__}")


class RawSnapshotStore:
    """Append-only immutable raw store: ``{base}/raw/{league}/{kind}/{ts}.json``."""

    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)

    def write(self, *, league: str, kind: str, payload: Any) -> Path:
        ts = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + f"_{time.time_ns() % 1_000_000:06d}"
        d = self._base / "raw" / league / kind
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{ts}.json"
        # Immutability: never overwrite an existing raw capture.
        if path.exists():  # pragma: no cover - ns suffix makes collision unlikely
            raise ValidationError(f"raw capture already exists (would overwrite): {path}")
        path.write_text(json.dumps(payload, default=_json_default, sort_keys=True))
        return path


class NormalizedStore:
    """Upsert-by-id JSONL store: ``{base}/normalized/{league}/{kind}.jsonl``."""

    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)

    def _path(self, league: str, kind: str) -> Path:
        d = self._base / "normalized" / league
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{kind}.jsonl"

    def read(self, *, league: str, kind: str) -> list[dict[str, Any]]:
        path = self._base / "normalized" / league / f"{kind}.jsonl"
        if not path.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line in path.read_text().splitlines():
            if line.strip():
                rows.append(json.loads(line))
        return rows

    def upsert(self, *, league: str, kind: str, key_field: str, records: list[Any]) -> int:
        """Merge ``records`` into the JSONL file, replacing rows with the same key."""
        path = self._path(league, kind)
        existing: dict[str, dict[str, Any]] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                existing[str(row.get(key_field))] = row
        for rec in records:
            row = asdict(rec) if is_dataclass(rec) and not isinstance(rec, type) else dict(rec)
            existing[str(row.get(key_field))] = row
        serialized = "\n".join(
            json.dumps(r, default=_json_default, sort_keys=True) for r in existing.values()
        )
        path.write_text(serialized + ("\n" if serialized else ""))
        return len(records)


class FixtureSync:
    """Discover active fixtures for a league and persist raw + normalized records."""

    def __init__(
        self,
        connector: OpticOddsConnector,
        *,
        raw: RawSnapshotStore,
        normalized: NormalizedStore,
    ) -> None:
        self._c = connector
        self._raw = raw
        self._norm = normalized

    async def sync(self, league: str) -> list[FixtureRecord]:
        rows = await self._c.active_fixtures(league)
        self._raw.write(league=league, kind="fixtures", payload=rows)
        records = [normalize_fixture(r, league=league) for r in rows]
        self._norm.upsert(league=league, kind="fixtures", key_field="fixture_id", records=records)
        return records


class OddsSync:
    """Fetch bounded odds snapshots for named US sportsbooks and persist them.

    Enforces ``MAX_SPORTSBOOKS_PER_BATCH`` and restricts to the three baseball
    main markets. Preserves a fixture that returns ``odds: []`` as a real, empty
    snapshot set (no fabrication).
    """

    def __init__(
        self,
        connector: OpticOddsConnector,
        *,
        raw: RawSnapshotStore,
        normalized: NormalizedStore,
    ) -> None:
        self._c = connector
        self._raw = raw
        self._norm = normalized

    async def sync(
        self,
        *,
        league: str,
        fixture_ids: list[str],
        sportsbooks: list[str],
        markets: list[str] | None = None,
        captured_at: datetime | None = None,
    ) -> list[OddsSnapshotRow]:
        books = [b.strip().lower() for b in sportsbooks if b.strip()]
        if not books:
            raise ValidationError("at least one sportsbook is required")
        if len(books) > MAX_SPORTSBOOKS_PER_BATCH:
            raise ValidationError(
                f"connector allows at most {MAX_SPORTSBOOKS_PER_BATCH} sportsbooks per batch, "
                f"got {len(books)}"
            )
        mkts = [m.strip().lower() for m in (markets or sorted(BASEBALL_MARKETS)) if m.strip()]
        bad = [m for m in mkts if m not in BASEBALL_MARKETS]
        if bad:
            allowed = sorted(BASEBALL_MARKETS)
            raise ValidationError(f"unsupported market(s) {bad}; allowed: {allowed}")
        if not fixture_ids:
            raise ValidationError("at least one fixture id is required")

        captured = (captured_at or datetime.now(UTC)).astimezone(UTC)
        fixtures = await self._c.fixture_odds(
            league=league, fixture_ids=fixture_ids, sportsbooks=books, markets=mkts
        )
        self._raw.write(league=league, kind="odds", payload=fixtures)
        rows: list[OddsSnapshotRow] = []
        for fx in fixtures:
            rows.extend(normalize_odds_fixture(fx, league=league, captured_at=captured))
        # Snapshots are historical facts: append (never upsert) keyed by a composite id.
        self._norm.upsert(
            league=league,
            kind="odds",
            key_field="_snap_key",
            records=[_with_snap_key(r) for r in rows],
        )
        return rows


class ResultSync:
    """Fetch and normalize completed results (labels only, never features)."""

    def __init__(
        self,
        connector: OpticOddsConnector,
        *,
        raw: RawSnapshotStore,
        normalized: NormalizedStore,
    ) -> None:
        self._c = connector
        self._raw = raw
        self._norm = normalized

    async def sync(self, *, league: str, fixture_ids: list[str]) -> list[ResultRecord]:
        if not fixture_ids:
            raise ValidationError("at least one fixture id is required")
        rows = await self._c.fixture_results(league=league, fixture_ids=fixture_ids)
        self._raw.write(league=league, kind="results", payload=rows)
        records = [normalize_result(r, league=league) for r in rows]
        self._norm.upsert(league=league, kind="results", key_field="fixture_id", records=records)
        return records


def _parse_dt(value: Any) -> datetime:
    dt = datetime.fromisoformat(str(value))
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)


def rebuild_fixture(row: dict[str, Any]) -> FixtureRecord:
    def comp(side: str) -> Competitor:
        c = row[side]
        return Competitor(
            team_id=str(c["team_id"]),
            name=str(c["name"]),
            abbreviation=c.get("abbreviation"),
            record=c.get("record"),
            starter_id=c.get("starter_id"),
            starter_name=c.get("starter_name"),
        )

    updated = row.get("updated_at")
    return FixtureRecord(
        fixture_id=str(row["fixture_id"]),
        game_id=row.get("game_id"),
        league=str(row["league"]),
        start_time=_parse_dt(row["start_time"]),
        status=str(row.get("status", "unknown")),
        is_live=bool(row.get("is_live", False)),
        has_odds=bool(row.get("has_odds", False)),
        home=comp("home"),
        away=comp("away"),
        venue=row.get("venue"),
        season_year=row.get("season_year"),
        season_type=row.get("season_type"),
        updated_at=_parse_dt(updated) if updated else None,
    )


def rebuild_odds(row: dict[str, Any]) -> OddsSnapshotRow:
    points = row.get("points")
    return OddsSnapshotRow(
        fixture_id=str(row["fixture_id"]),
        league=str(row["league"]),
        sportsbook=str(row["sportsbook"]),
        market_id=str(row["market_id"]),
        selection=str(row.get("selection", "")),
        normalized_selection=str(row.get("normalized_selection", "")),
        price=float(row["price"]),
        points=float(points) if points is not None else None,
        published_at=_parse_dt(row["published_at"]),
        captured_at=_parse_dt(row["captured_at"]),
        is_main=bool(row.get("is_main", True)),
        team_id=row.get("team_id"),
        player_id=row.get("player_id"),
        grouping_key=row.get("grouping_key"),
    )


def rebuild_result(row: dict[str, Any]) -> ResultRecord:
    return ResultRecord(
        fixture_id=str(row["fixture_id"]),
        league=str(row["league"]),
        home_score=row.get("home_score"),
        away_score=row.get("away_score"),
        status=str(row.get("status", "pending")),
        is_final=bool(row.get("is_final", False)),
        voided=bool(row.get("voided", False)),
    )


def _with_snap_key(row: OddsSnapshotRow) -> dict[str, Any]:
    """Serialize an odds row with a composite dedup key (book+market+sel+publish time)."""
    d = asdict(row)
    d["_snap_key"] = "|".join(
        [
            row.fixture_id,
            row.sportsbook,
            row.market_id,
            row.normalized_selection,
            row.published_at.isoformat(),
        ]
    )
    return d
