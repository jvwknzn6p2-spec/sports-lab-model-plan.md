"""FastAPI application factory."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.exception_handlers import register_exception_handlers
from app.api.routes import (
    errors,
    health,
    learning,
    locks,
    model,
    predictions,
    settlements,
)
from app.core.config import get_settings
from app.core.ids import correlation_id as new_correlation_id
from app.core.logging import configure_logging, get_logger

logger = get_logger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    logger.info("startup", app=settings.app_name, environment=settings.environment)
    yield
    logger.info("shutdown", app=settings.app_name)


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)

    app = FastAPI(
        title="HandiEdge Engine",
        version=settings.schema_version,
        description="Production-oriented sports prediction execution pipeline.",
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def correlation_and_limits(request: Request, call_next):
        # Enforce request size limit.
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > settings.max_request_bytes:
            return JSONResponse(
                status_code=413,
                content={
                    "error_code": "REQUEST_TOO_LARGE",
                    "message": "request body exceeds the configured limit",
                    "details": {"max_bytes": settings.max_request_bytes},
                    "correlation_id": None,
                },
            )
        cid = request.headers.get("x-correlation-id") or new_correlation_id()
        request.state.correlation_id = cid
        response = await call_next(request)
        response.headers["x-correlation-id"] = cid
        return response

    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(model.router)
    app.include_router(predictions.router)
    app.include_router(locks.router)
    app.include_router(settlements.router)
    app.include_router(errors.router)
    app.include_router(learning.router)
    return app


app = create_app()
