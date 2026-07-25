"""Masking and leak detection for outbound external-provider payloads.

Any payload routed to a non-Kimi provider must be masked: L1 fields are removed
entirely, and a leak detector rejects the payload if any hash-like token survives.
This is enforced by the CRITICAL test ``tests/test_masking.py`` — if it is not
green, deployment must be blocked.
"""

from __future__ import annotations

import re
from typing import Any

from ..errors import LeakDetectedError
from .types import L1_FIELDS

# A "hash-like" token: 12+ hex chars — the shape of feature/model-weights hashes.
_HASH_RE = re.compile(r"\b[0-9a-fA-F]{12,}\b")


def mask(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a copy with all L1 fields removed (recursively)."""
    out: dict[str, Any] = {}
    for k, v in payload.items():
        if k in L1_FIELDS:
            continue
        if isinstance(v, dict):
            out[k] = mask(v)
        else:
            out[k] = v
    return out


def verify_no_leak(payload: dict[str, Any]) -> None:
    """Raise :class:`LeakDetectedError` if any L1 field or hash-like value remains.

    No silent fallback — a suspected leak is a hard failure.
    """

    def _walk(obj: Any) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in L1_FIELDS:
                    raise LeakDetectedError(f"L1 field {k!r} present in outbound payload")
                _walk(v)
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                _walk(item)
        elif isinstance(obj, str):
            if _HASH_RE.search(obj):
                raise LeakDetectedError(f"hash-like token detected in outbound payload: {obj!r}")

    _walk(payload)
