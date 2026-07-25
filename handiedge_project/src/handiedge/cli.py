"""HandiEdge command-line interface (audit category 12).

Subcommands operate per ``--league {mlb,npb}`` and keep the two leagues fully
isolated on disk (``{data_dir}/{raw,normalized,datasets,artifacts}/{league}/...``).

Live commands (``sync-fixtures``, ``sync-odds``, ``sync-results``) talk to the
runtime ``external-tool`` connector. When the binary is absent/disconnected they
print a truthful *connector-unavailable* message and exit non-zero — they never
fabricate fixtures, odds or results. Offline commands (``build-dataset``,
``train``, ``evaluate``, ``predict``) work entirely on locally persisted data.

Nothing here manufactures training rows or claims performance: an empty dataset
trains an UNTRAINED artifact and ``predict`` refuses to serve from it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .config import get_settings
from .connector.external_tool import ExternalToolClient, OpticOddsConnector
from .errors import ConnectorError, ConnectorUnavailable, HandiEdgeError, NotReady
from .leagues.artifacts import LeagueArtifact, load_artifact
from .leagues.datasets import Dataset, build_training_dataset
from .leagues.ingest import (
    FixtureSync,
    NormalizedStore,
    OddsSync,
    RawSnapshotStore,
    ResultSync,
    rebuild_fixture,
    rebuild_odds,
    rebuild_result,
)
from .leagues.pipeline import LeaguePredictor, train_market
from .leagues.profiles import get_profile, parse_league, parse_market


def _connector(settings: Any) -> OpticOddsConnector:
    client = ExternalToolClient(
        source_id=settings.opticodds_source_id,
        tool_name=settings.opticodds_tool_name,
        binary=settings.external_tool_bin,
        timeout_s=settings.external_tool_timeout_s,
    )
    return OpticOddsConnector(client)


def _require_connector(settings: Any) -> None:
    if not ExternalToolClient.is_available(settings.external_tool_bin):
        raise ConnectorUnavailable(
            f"external-tool binary {settings.external_tool_bin!r} not found on PATH; "
            "live connector is unavailable in this environment"
        )


def _stores(settings: Any) -> tuple[RawSnapshotStore, NormalizedStore]:
    return RawSnapshotStore(settings.data_dir), NormalizedStore(settings.data_dir)


def _dataset_path(settings: Any, league: str, market: str) -> Path:
    return Path(settings.data_dir) / "datasets" / league / f"{market}.npz"


# -- live subcommands --------------------------------------------------------


def _cmd_sync_fixtures(args: argparse.Namespace) -> int:
    settings = get_settings()
    _require_connector(settings)
    league = parse_league(args.league).value
    raw, norm = _stores(settings)
    sync = FixtureSync(_connector(settings), raw=raw, normalized=norm)
    fixtures = asyncio.run(sync.sync(league))
    print(f"synced {len(fixtures)} {league} fixtures")
    return 0


def _cmd_sync_odds(args: argparse.Namespace) -> int:
    settings = get_settings()
    _require_connector(settings)
    league = parse_league(args.league).value
    raw, norm = _stores(settings)
    fixture_ids = args.fixture_id or [
        r["fixture_id"] for r in norm.read(league=league, kind="fixtures")
    ]
    if not fixture_ids:
        print("no fixture ids supplied and none on disk; run sync-fixtures first", file=sys.stderr)
        return 2
    sync = OddsSync(_connector(settings), raw=raw, normalized=norm)
    rows = asyncio.run(
        sync.sync(
            league=league,
            fixture_ids=fixture_ids,
            sportsbooks=args.sportsbook or settings.sportsbook_list(),
            markets=args.market,
        )
    )
    print(f"synced {len(rows)} {league} odds rows across {len(fixture_ids)} fixtures")
    return 0


def _cmd_sync_results(args: argparse.Namespace) -> int:
    settings = get_settings()
    _require_connector(settings)
    league = parse_league(args.league).value
    raw, norm = _stores(settings)
    fixture_ids = args.fixture_id or [
        r["fixture_id"] for r in norm.read(league=league, kind="fixtures")
    ]
    if not fixture_ids:
        print("no fixture ids supplied and none on disk; run sync-fixtures first", file=sys.stderr)
        return 2
    sync = ResultSync(_connector(settings), raw=raw, normalized=norm)
    results = asyncio.run(sync.sync(league=league, fixture_ids=fixture_ids))
    print(f"synced {len(results)} {league} results")
    return 0


# -- offline subcommands -----------------------------------------------------


def _cmd_build_dataset(args: argparse.Namespace) -> int:
    settings = get_settings()
    league = parse_league(args.league)
    market = parse_market(args.market)
    profile = get_profile(league)
    _, norm = _stores(settings)

    fixtures = [rebuild_fixture(r) for r in norm.read(league=league.value, kind="fixtures")]
    snapshots = [rebuild_odds(r) for r in norm.read(league=league.value, kind="odds")]
    results = [rebuild_result(r) for r in norm.read(league=league.value, kind="results")]

    ds = build_training_dataset(
        profile,
        market,
        snapshots=snapshots,
        results=results,
        fixtures=fixtures,
        is_synthetic=args.synthetic,
    )
    out = _dataset_path(settings, league.value, market.value)
    ds.save_npz(str(out))
    print(f"built {league.value}/{market.value} dataset with {ds.n} rows -> {out}")
    if ds.n == 0:
        print("note: 0 usable rows (no labelable completed fixtures with as-of odds yet)")
    return 0


def _cmd_train(args: argparse.Namespace) -> int:
    settings = get_settings()
    league = parse_league(args.league)
    market = parse_market(args.market)
    profile = get_profile(league)
    ds_path = _dataset_path(settings, league.value, market.value)
    if not ds_path.exists():
        print(f"no dataset at {ds_path}; run build-dataset first", file=sys.stderr)
        return 2
    ds = Dataset.load_npz(str(ds_path))
    artifact = train_market(profile, market, ds)
    base = str(Path(settings.data_dir) / "artifacts")
    path = artifact.save(base)
    status = "TRAINED" if artifact.trained else "UNTRAINED (insufficient real data)"
    print(f"{league.value}/{market.value}: {status} -> {path}")
    if artifact.trained:
        print("metrics:", json.dumps(artifact.metrics, indent=2, sort_keys=True))
    return 0


def _cmd_evaluate(args: argparse.Namespace) -> int:
    settings = get_settings()
    league = parse_league(args.league)
    market = parse_market(args.market)
    base = str(Path(settings.data_dir) / "artifacts")
    try:
        artifact = load_artifact(base, expected_league=league, expected_market=market)
    except FileNotFoundError:
        print(f"no {league.value}/{market.value} artifact; run train first", file=sys.stderr)
        return 2
    _print_eval(artifact)
    return 0


def _print_eval(artifact: LeagueArtifact) -> None:
    print(f"league={artifact.league.value} market={artifact.market.value}")
    print(f"trained={artifact.trained} synthetic={artifact.is_synthetic}")
    print(f"n_train={artifact.n_train} n_test={artifact.n_test}")
    if artifact.trained:
        print("metrics:", json.dumps(artifact.metrics, indent=2, sort_keys=True))
    else:
        print("UNTRAINED: ingest real historical data and train before quoting any metric.")


def _cmd_predict(args: argparse.Namespace) -> int:
    settings = get_settings()
    league = parse_league(args.league)
    market = parse_market(args.market)
    profile = get_profile(league)
    base = str(Path(settings.data_dir) / "artifacts")
    try:
        artifact = load_artifact(base, expected_league=league, expected_market=market)
    except FileNotFoundError:
        print(f"no {league.value}/{market.value} artifact; run train first", file=sys.stderr)
        return 2
    if not args.features_json:
        print("--features-json <path> with a JSON list of feature rows required", file=sys.stderr)
        return 2
    rows = json.loads(Path(args.features_json).read_text())
    predictor = LeaguePredictor(profile, artifact)
    try:
        preds = predictor.predict(rows, n_lines_seen=args.n_lines_seen)
    except NotReady as exc:
        print(f"cannot predict: {exc}", file=sys.stderr)
        return 3
    print(json.dumps([asdict(p) for p in preds], indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="handiedge", description="HandiEdge league CLI")
    sub = p.add_subparsers(dest="command", required=True)

    def add_league(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--league", required=True, help="mlb or npb")

    sp = sub.add_parser("sync-fixtures", help="discover active fixtures (live)")
    add_league(sp)
    sp.set_defaults(func=_cmd_sync_fixtures)

    sp = sub.add_parser("sync-odds", help="fetch bounded odds snapshots (live)")
    add_league(sp)
    sp.add_argument("--fixture-id", action="append", help="repeatable; default = all on disk")
    sp.add_argument("--sportsbook", action="append", help="repeatable; max 5 US books")
    sp.add_argument("--market", action="append", help="moneyline|run_line|total_runs")
    sp.set_defaults(func=_cmd_sync_odds)

    sp = sub.add_parser("sync-results", help="fetch completed results for labels (live)")
    add_league(sp)
    sp.add_argument("--fixture-id", action="append", help="repeatable; default = all on disk")
    sp.set_defaults(func=_cmd_sync_results)

    sp = sub.add_parser("build-dataset", help="build league-isolated as-of dataset (offline)")
    add_league(sp)
    sp.add_argument("--market", required=True)
    sp.add_argument(
        "--synthetic",
        action="store_true",
        help="mark the dataset (and any artifact) as synthetic (tests/dev only)",
    )
    sp.set_defaults(func=_cmd_build_dataset)

    sp = sub.add_parser("train", help="train + calibrate on a temporal split (offline)")
    add_league(sp)
    sp.add_argument("--market", required=True)
    sp.set_defaults(func=_cmd_train)

    sp = sub.add_parser("evaluate", help="print held-out metrics / trained status (offline)")
    add_league(sp)
    sp.add_argument("--market", required=True)
    sp.set_defaults(func=_cmd_evaluate)

    sp = sub.add_parser("predict", help="serve calibrated probabilities + abstention (offline)")
    add_league(sp)
    sp.add_argument("--market", required=True)
    sp.add_argument("--features-json", help="path to a JSON list of feature rows")
    sp.add_argument("--n-lines-seen", type=int, default=1)
    sp.set_defaults(func=_cmd_predict)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ConnectorUnavailable as exc:
        print(f"connector unavailable: {exc}", file=sys.stderr)
        return 4
    except ConnectorError as exc:
        print(f"connector error: {exc}", file=sys.stderr)
        return 5
    except (ValueError, HandiEdgeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
