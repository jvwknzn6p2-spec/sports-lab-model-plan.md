"""Append-only, hash-chained audit log (audit category 11).

Critical invariant: the generation and verification algorithms are the *same*
function. The v1.1 skeleton had a generation/verification mismatch (app-side used
``prev_hash + canonical(entry) + pepper``; the SQL verifier used a different
concatenation without the pepper). Here both directions call :func:`compute_hash`,
so they cannot drift.

The pepper is sourced from settings (env var ``HANDIEDGE_AUDIT_LOG_PEPPER``); if it
is absent the chain raises :class:`NotConfigured` rather than silently using an
empty pepper.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..errors import NotConfigured

GENESIS = "0" * 64


def canonical(obj: dict) -> str:
    """Deterministic JSON: sorted keys, no whitespace."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_hash(prev_hash: str, entry: dict, pepper: str) -> str:
    """The single source of truth for chain hashing (generation AND verification)."""
    material = prev_hash + canonical(entry) + pepper
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class AuditRecord:
    entry: dict
    prev_hash: str
    self_hash: str
    occurred_at: datetime


@dataclass(slots=True)
class AuditChain:
    pepper: str
    _records: list[AuditRecord] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.pepper:
            raise NotConfigured("audit chain requires a non-empty pepper (AUDIT_LOG_PEPPER)")

    @property
    def head(self) -> str:
        return self._records[-1].self_hash if self._records else GENESIS

    def append(self, entry: dict) -> AuditRecord:
        prev = self.head
        self_hash = compute_hash(prev, entry, self.pepper)
        rec = AuditRecord(entry, prev, self_hash, datetime.now(UTC))
        self._records.append(rec)
        return rec

    def verify(self) -> list[int]:
        """Return indices of any records whose hash does not verify. Empty => intact."""
        broken: list[int] = []
        prev = GENESIS
        for i, rec in enumerate(self._records):
            expected = compute_hash(prev, rec.entry, self.pepper)
            if expected != rec.self_hash or rec.prev_hash != prev:
                broken.append(i)
            prev = rec.self_hash
        return broken

    def __len__(self) -> int:
        return len(self._records)
