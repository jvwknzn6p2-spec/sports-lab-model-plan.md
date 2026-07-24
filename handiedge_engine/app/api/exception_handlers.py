"""Consistent error responses for domain and unexpected exceptions."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.clock import isoformat_utc, utc_now
from app.core.exceptions import HandiEdgeError
from app.core.logging import get_logger

logger = get_logger("api")


def _correlation(request: Request) -> str | None:
    return getattr(request.state, "correlation_id", None)


def _envelope(error_code: str, message: str, details: dict, cid: str | None) -> dict:
    return {
        "error_code": error_code,
        "message": message,
        "details": details,
        "correlation_id": cid,
        "timestamp": isoformat_utc(utc_now()),
    }


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(HandiEdgeError)
    async def _handle_domain(request: Request, exc: HandiEdgeError) -> JSONResponse:
        cid = _correlation(request)
        logger.warning(
            "domain_error", error_code=exc.error_code, message=exc.message, correlation_id=cid
        )
        return JSONResponse(
            status_code=exc.http_status,
            content=_envelope(exc.error_code, exc.message, exc.details, cid),
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        cid = _correlation(request)
        return JSONResponse(
            status_code=422,
            content=_envelope(
                "REQUEST_VALIDATION_ERROR",
                "request body failed validation",
                {"errors": exc.errors()},
                cid,
            ),
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        cid = _correlation(request)
        logger.error("unexpected_error", error=str(exc), correlation_id=cid)
        return JSONResponse(
            status_code=500,
            content=_envelope(
                "INTERNAL_ERROR", "an unexpected error occurred", {}, cid
            ),
        )
