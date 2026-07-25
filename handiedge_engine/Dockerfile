# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps for psycopg build (binary wheel usually suffices; keep minimal).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
# INSTALL_XGBOOST=true (default) bakes in the production XGBoost adapter so the
# real model can run in the container; set to false for a slim fallback-only image.
ARG INSTALL_XGBOOST=true
COPY pyproject.toml README.md ./
RUN if [ "$INSTALL_XGBOOST" = "true" ]; then \
        pip install ".[dev,xgboost]"; \
    else \
        pip install ".[dev]"; \
    fi

# Copy the application source.
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./alembic.ini
COPY examples ./examples
COPY scripts ./scripts
COPY tests ./tests

RUN chmod +x scripts/docker-entrypoint.sh

# Non-root runtime user; the artifacts dir is writable so train-if-missing works.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/artifacts \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

ENTRYPOINT ["scripts/docker-entrypoint.sh"]
