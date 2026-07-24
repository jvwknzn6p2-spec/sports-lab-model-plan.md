"""Canonical JSON serialization and SHA-256 hashing.

Payload hashes drive idempotency, lock integrity, and audit correlation, so the
serialization must be *canonical*: identical logical content always produces an
identical byte string regardless of key ordering or insignificant whitespace.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any


def _default(value: Any) -> Any:
    if isinstance(value, Decimal):
        # Normalize to a plain string to avoid float rounding surprises.
        return format(value.normalize(), "f")
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    raise TypeError(f"Object of type {type(value).__name__} is not serializable")


def canonical_json(payload: Any) -> str:
    """Serialize ``payload`` to a canonical, sorted, compact JSON string."""

    return json.dumps(
        payload,
        default=_default,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def sha256_hex(payload: Any) -> str:
    """Return the SHA-256 hex digest of the canonical serialization of ``payload``."""

    canonical = canonical_json(payload)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
