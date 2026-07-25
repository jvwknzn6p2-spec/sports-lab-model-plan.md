"""Audit hash-chain tests (audit category 11).

Verifies the critical invariant that generation and verification use the same
algorithm, so a valid chain verifies and any tampering is detected.
"""

from __future__ import annotations

import pytest

from handiedge.errors import NotConfigured
from handiedge.security.audit_chain import GENESIS, AuditChain, compute_hash


def test_chain_verifies_when_intact():
    chain = AuditChain(pepper="test-pepper")
    chain.append({"action": "POST /predict", "result": "success"})
    chain.append({"action": "GET /health", "result": "success"})
    assert chain.verify() == []
    assert len(chain) == 2


def test_first_record_links_to_genesis():
    chain = AuditChain(pepper="p")
    rec = chain.append({"action": "x"})
    assert rec.prev_hash == GENESIS
    assert rec.self_hash == compute_hash(GENESIS, {"action": "x"}, "p")


def test_tampering_detected():
    chain = AuditChain(pepper="p")
    chain.append({"action": "a", "result": "success"})
    chain.append({"action": "b", "result": "success"})
    # Tamper with the first record's entry after the fact.
    chain._records[0].entry["result"] = "failure"
    broken = chain.verify()
    assert 0 in broken


def test_pepper_required():
    with pytest.raises(NotConfigured):
        AuditChain(pepper="")


def test_generation_equals_verification_across_pepper():
    # A different pepper must not verify a chain built with another pepper.
    chain = AuditChain(pepper="secret1")
    chain.append({"action": "a"})
    other = AuditChain(pepper="secret2")
    other._records = chain._records  # inject records built with the wrong pepper
    assert other.verify() == [0]
