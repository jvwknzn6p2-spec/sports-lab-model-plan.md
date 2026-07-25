"""Prediction service + API integration tests (categories 9, 11, 12, 14)."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from handiedge.config import get_settings
from handiedge.modeling.abstention import AbstentionPolicy
from handiedge.service.api import create_app
from handiedge.service.contracts import Decision, PredictionResponse
from handiedge.service.prediction import PredictionService


class StubModel:
    """Deterministic model: high prob A covers, independent of features."""

    def __init__(self, p=0.7):
        self.p = p

    def predict_proba(self, X):
        return np.full(X.shape[0], self.p)


def _service(seed, p=0.7, abstain=None):
    return PredictionService(
        ingestor=seed.ingestor,
        feature_builder=seed.feature_builder,
        model=StubModel(p),
        model_version="stub-1",
        abstention=abstain
        or AbstentionPolicy(min_edge=0.01, min_confidence=0.55, min_history_lines=1),
    )


def test_service_emits_bet_with_disclaimer(seed):
    resp = _service(seed).predict(seed.event)
    assert isinstance(resp, PredictionResponse)
    assert resp.decision is Decision.BET
    assert resp.prob_a is not None and resp.feature_hash
    assert "not a guarantee" in resp.disclaimer.lower()
    assert resp.uncertainty is not None
    assert resp.kelly_fraction is not None and resp.kelly_fraction >= 0


def test_service_abstains_low_confidence(seed):
    resp = _service(seed, p=0.5).predict(seed.event)  # no edge -> abstain
    assert resp.decision is Decision.ABSTAIN
    assert resp.abstain_reason is not None


def test_rationale_rejects_guarantee_language():
    with pytest.raises(Exception):
        PredictionResponse(
            event_id=__import__("uuid").uuid4(),
            decision=Decision.ABSTAIN,
            abstain_reason=None,  # also invalid, but rationale validator fires first
            model_version="x",
            feature_hash="h",
            data_as_of=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
            generated_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
            rationale="This is a guaranteed win",
        )


def test_health_and_ready_truthful():
    app = create_app(settings=get_settings(environment="dev"))
    client = TestClient(app)
    assert client.get("/health").json()["status"] == "ok"
    ready = client.get("/ready").json()
    # No MLflow / inference configured => not ready, reported truthfully.
    assert ready["ready"] is False
    assert (
        "not_ready" in ready["dependencies"]["model_registry"]
        or "not_" in ready["dependencies"]["model_registry"]
    )


def test_metrics_requires_key():
    app = create_app(settings=get_settings(metrics_api_key="secret"))
    client = TestClient(app)
    assert client.get("/internal/metrics").status_code == 401
    ok = client.get("/internal/metrics", headers={"x-metrics-key": "secret"})
    assert ok.status_code == 200


def test_predict_endpoint_jurisdiction_block(seed):
    settings = get_settings(blocked_jurisdictions="US", min_age=18)
    app = create_app(
        settings=settings,
        service=_service(seed),
        event_lookup=lambda _id: seed.event,
    )
    client = TestClient(app)
    blocked = client.post(
        "/predict", json={"event_id": str(seed.event.event_id), "jurisdiction": "US", "age": 40}
    )
    assert blocked.status_code == 403
    ok = client.post(
        "/predict", json={"event_id": str(seed.event.event_id), "jurisdiction": "JP", "age": 25}
    )
    assert ok.status_code == 200
    assert ok.json()["disclaimer"]


def test_docs_disabled_in_prod():
    app = create_app(settings=get_settings(environment="prod"))
    client = TestClient(app)
    assert client.get("/docs").status_code == 404
