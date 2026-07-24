"""Shared pytest fixtures.

Every test runs against an isolated, file-backed SQLite database created fresh
from the ORM metadata, so no external services are required.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# Configure an isolated SQLite database BEFORE importing app modules that read
# settings at import time.
os.environ.setdefault("HANDIEDGE_ENVIRONMENT", "test")


@pytest.fixture()
def db_url(tmp_path: Path) -> str:
    return f"sqlite+pysqlite:///{tmp_path / 'test.db'}"


@pytest.fixture()
def settings(db_url, monkeypatch):
    monkeypatch.setenv("HANDIEDGE_DATABASE_URL", db_url)
    from app.core.config import get_settings, reset_settings_cache

    reset_settings_cache()
    s = get_settings()
    yield s
    reset_settings_cache()


@pytest.fixture()
def engine(settings):
    from app.infrastructure.database.base import Base
    from app.infrastructure.database.session import get_engine, reset_engine

    reset_engine()
    eng = get_engine()
    Base.metadata.create_all(bind=eng)
    yield eng
    Base.metadata.drop_all(bind=eng)
    reset_engine()


@pytest.fixture()
def session(engine):
    from app.infrastructure.database.session import get_session_factory

    factory = get_session_factory()
    sess = factory()
    try:
        yield sess
        sess.commit()
    finally:
        sess.close()


@pytest.fixture()
def examples_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "examples"


@pytest.fixture()
def valid_payload(examples_dir) -> dict:
    return json.loads((examples_dir / "control_tower_valid.json").read_text())


@pytest.fixture()
def adapter():
    from app.domain.prediction.deterministic_fallback import DeterministicFallbackAdapter

    return DeterministicFallbackAdapter()


@pytest.fixture()
def api_client(engine, settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as client:
        yield client
