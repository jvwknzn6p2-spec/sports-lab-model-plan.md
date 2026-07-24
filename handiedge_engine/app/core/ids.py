"""Identifier generation helpers.

UUIDv4 is used for all surrogate keys. A dedicated indirection keeps the rest of
the codebase free of ``uuid`` imports and lets tests substitute deterministic
generators when needed.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable


def _default_factory() -> str:
    return str(uuid.uuid4())


_id_factory: Callable[[], str] = _default_factory


def new_id() -> str:
    return _id_factory()


def correlation_id() -> str:
    return "cid-" + new_id()


def set_id_factory(factory: Callable[[], str]) -> None:
    """Override the id factory (used by deterministic tests only)."""

    global _id_factory
    _id_factory = factory
