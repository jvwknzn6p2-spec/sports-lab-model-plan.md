"""CRITICAL: L1 data must never reach an external provider (audit category 11).

If this test is not green, deployment must be blocked.
"""

from __future__ import annotations

import pytest

from handiedge.errors import LeakDetectedError
from handiedge.gateway.masking import mask, verify_no_leak
from handiedge.gateway.router import ROUTING_MATRIX, Router
from handiedge.gateway.types import Classification, ProviderName, TaskType


@pytest.mark.parametrize(
    "provider",
    [
        ProviderName.GEMINI,
        ProviderName.GROK,
        ProviderName.CLAUDE,
        ProviderName.OPENAI_SOL,
        ProviderName.DEEPSEEK,
    ],
)
def test_l1_data_never_reaches_external_providers(provider):
    payload = {
        "predictor_id": "core4_alpha",  # L1
        "model_weights_hash": "abc123deadbeef",  # L1
        "feature_hash": "fingerprint0000",  # L1
        "game_summary": "Giants vs Tigers 18:00",  # L3
    }
    masked = mask(payload)
    assert "predictor_id" not in masked
    assert "model_weights_hash" not in masked
    assert "feature_hash" not in masked
    verify_no_leak(masked)  # no exception == pass
    # Sanity: the provider under test is an external one.
    assert provider is not ProviderName.KIMI_K3


def test_verify_no_leak_raises_on_pattern_match():
    # A hash-like token embedded in an allowed field must still be caught.
    with pytest.raises(LeakDetectedError):
        verify_no_leak({"game_summary": "leaked hash deadbeefcafe1234"})


def test_verify_no_leak_raises_on_l1_key():
    with pytest.raises(LeakDetectedError):
        verify_no_leak({"predictor_id": "x"})


def test_all_l1_routes_go_to_kimi():
    for (task, cls), prov in ROUTING_MATRIX.items():
        if cls is Classification.L1:
            assert prov is ProviderName.KIMI_K3, (task, prov)


def test_router_unknown_cell_falls_back_to_kimi():
    r = Router()
    assert r.pick(TaskType.SUMMARY, Classification.L1) is ProviderName.KIMI_K3
    # Unknown (SENTIMENT, L2) not in matrix -> safest fallback.
    assert r.pick(TaskType.SENTIMENT, Classification.L2) is ProviderName.KIMI_K3
