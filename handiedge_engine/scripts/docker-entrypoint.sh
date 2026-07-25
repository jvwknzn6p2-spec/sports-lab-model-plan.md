#!/usr/bin/env bash
# Container entrypoint: apply migrations, ensure a model artifact exists when the
# XGBoost adapter is selected, then start the API. Idempotent and safe to re-run.
set -euo pipefail

echo "[entrypoint] applying database migrations..."
alembic upgrade head

if [ "${HANDIEDGE_MODEL_ADAPTER:-fallback}" = "xgboost" ]; then
    ARTIFACT_DIR="${HANDIEDGE_MODEL_ARTIFACT_DIR:-artifacts/xgboost_mlb}"
    if [ ! -f "${ARTIFACT_DIR}/metadata.json" ]; then
        echo "[entrypoint] xgboost adapter selected but no artifact at ${ARTIFACT_DIR}; training (reproducible, seeded)..."
        python scripts/train_xgboost.py --out "${ARTIFACT_DIR}" --rows 4000 --seed 7
    else
        echo "[entrypoint] reusing existing model artifact at ${ARTIFACT_DIR}"
    fi
fi

echo "[entrypoint] starting API..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
