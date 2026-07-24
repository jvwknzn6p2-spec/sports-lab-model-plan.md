"""FastAPI dependencies: DB session per request, settings, adapter, auth, correlation."""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.ids import correlation_id as new_correlation_id
from app.domain.prediction.adapter import PredictionAdapter
from app.infrastructure.database.session import get_session_factory
from app.infrastructure.model_adapters.registry import get_adapter


def get_settings_dep() -> Settings:
    return get_settings()


def get_db() -> Iterator[Session]:
    """Yield a request-scoped session with commit/rollback semantics."""

    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_prediction_adapter() -> PredictionAdapter:
    return get_adapter("default")


def get_correlation_id(
    request: Request,
    x_correlation_id: str | None = Header(default=None),
) -> str:
    cid = x_correlation_id or new_correlation_id()
    request.state.correlation_id = cid
    return cid


def require_api_key(
    settings: Settings = Depends(get_settings_dep),
    x_api_key: str | None = Header(default=None),
) -> None:
    """Minimal API-key auth for the MVP.

    Disabled unless ``HANDIEDGE_REQUIRE_API_KEY=true``. See the README for how to
    replace this with production authentication (OIDC / mTLS / gateway).
    """

    if not settings.require_api_key:
        return
    if not settings.api_key or x_api_key != settings.api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or missing API key"
        )
