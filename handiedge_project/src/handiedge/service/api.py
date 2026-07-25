"""FastAPI application (categories 9, 11, 12, 14).

Endpoints:
- ``POST /predict``            : prediction with RG age/jurisdiction gating;
- ``GET  /health``             : liveness (always cheap);
- ``GET  /ready``              : readiness — reports external-dependency status
                                  truthfully (NotConfigured => not ready, not faked);
- ``GET  /internal/metrics``   : requires an API key; network-restricted by deploy.

The app is constructed via a factory so tests inject a fully offline service.
OpenAPI docs are disabled in prod (environment == 'prod').
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, status

from ..config import Settings, get_settings
from ..errors import (
    JurisdictionBlocked,
    LeagueMismatchError,
    NotConfigured,
    NotReady,
    UnsupportedMarketError,
)
from ..leagues.artifacts import load_artifact
from ..leagues.pipeline import LeaguePredictor
from ..leagues.profiles import PROFILES, BaseballMarket, get_profile, parse_league, parse_market
from ..modeling.abstention import AbstainReason
from ..ports.external import (
    default_inference_server,
    default_registry,
)
from ..responsible.gambling import ResponsibleGamblingGate
from .contracts import (
    Decision,
    LeaguePredictionItem,
    LeaguePredictionRequest,
    LeaguePredictionResponse,
    PredictionRequest,
    PredictionResponse,
)
from .prediction import PredictionService


def create_app(
    *,
    settings: Settings | None = None,
    service: PredictionService | None = None,
    event_lookup: Callable[[str], object] | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    docs_url = None if settings.is_prod else "/docs"
    app = FastAPI(title="HandiEdge Prediction API", version="0.1.0", docs_url=docs_url)

    gate = ResponsibleGamblingGate(settings)
    registry = default_registry(settings)
    inference = default_inference_server(settings)

    def require_metrics_key(x_metrics_key: str | None = Header(default=None)) -> None:
        if settings.metrics_api_key is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "metrics not configured")
        if x_metrics_key != settings.metrics_api_key.get_secret_value():
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid metrics key")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "environment": settings.environment}

    @app.get("/ready")
    def ready() -> dict:
        """Readiness reflects real dependency status; unconfigured => not ready."""
        deps: dict[str, str] = {}
        try:
            registry.load_production_model("NPB")
            deps["model_registry"] = "ready"
        except (NotConfigured, NotReady) as exc:
            deps["model_registry"] = f"not_ready: {exc.__class__.__name__}"
        deps["inference_server"] = "ready" if inference.health() else "not_ready"
        ok = all(v == "ready" for v in deps.values())
        return {"ready": ok, "dependencies": deps}

    @app.post("/predict", response_model=PredictionResponse)
    def predict(req: PredictionRequest) -> PredictionResponse:
        try:
            gate.enforce(jurisdiction=req.jurisdiction, age=req.age)
        except JurisdictionBlocked as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        if service is None or event_lookup is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "prediction service not configured in this deployment",
            )
        event = event_lookup(str(req.event_id))
        if event is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "event not found")
        return service.predict(event)  # type: ignore[arg-type]

    @app.get("/leagues")
    def leagues() -> dict:
        """Supported leagues and their markets (isolation is per-league)."""
        return {
            "leagues": [
                {
                    "league": p.league.value,
                    "sport": p.sport.value,
                    "display_timezone": p.display_timezone,
                    "markets": [m.value for m in BaseballMarket],
                }
                for p in PROFILES.values()
            ]
        }

    @app.post("/leagues/{league}/predict", response_model=LeaguePredictionResponse)
    def league_predict(league: str, req: LeaguePredictionRequest) -> LeaguePredictionResponse:
        try:
            parsed_league = parse_league(league)
            market = parse_market(req.market)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

        profile = get_profile(parsed_league)
        base_dir = f"{settings.data_dir}/artifacts"
        try:
            artifact = load_artifact(
                base_dir, expected_league=parsed_league, expected_market=market
            )
        except FileNotFoundError as exc:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                f"no {parsed_league.value}/{market.value} artifact trained yet",
            ) from exc
        except LeagueMismatchError as exc:
            # A stored artifact belongs to another league/market — refuse to cross.
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

        try:
            predictor = LeaguePredictor(profile, artifact)
            preds = predictor.predict(
                np.asarray(req.features, dtype=float), n_lines_seen=req.n_lines_seen
            )
        except LeagueMismatchError as exc:  # feature width mismatch
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        except UnsupportedMarketError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        except NotReady as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

        items = [
            LeaguePredictionItem(
                prob=p.prob,
                fair_prob=p.fair_prob,
                edge=p.edge,
                decision=Decision.ABSTAIN if p.abstain else Decision.BET,
                abstain_reason=(AbstainReason(p.abstain_reason) if p.abstain_reason else None),
            )
            for p in preds
        ]
        return LeaguePredictionResponse(
            league=parsed_league.value,
            market=market.value,
            model_trained=artifact.trained,
            is_synthetic=artifact.is_synthetic,
            predictions=items,
        )

    @app.get("/internal/metrics", dependencies=[Depends(require_metrics_key)])
    def metrics() -> dict:
        return {"predictions_served": "n/a (offline build)", "note": "wire Prometheus here"}

    return app
