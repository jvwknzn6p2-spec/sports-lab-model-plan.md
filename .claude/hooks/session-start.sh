#!/bin/bash
# SessionStart hook: install dependencies so tests and linters are runnable
# immediately in Claude Code on the web sessions.
#
# Idempotent and non-interactive: safe to re-run. The container state is cached
# after this completes, so subsequent sessions reuse the installed packages.
set -euo pipefail

# Only run in the remote (web) environment; local setups manage their own venvs.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT"

# --- JavaScript workspace (pnpm) -------------------------------------------
if command -v pnpm >/dev/null 2>&1 && [ -f "pnpm-workspace.yaml" ]; then
  echo "[session-start] installing pnpm workspace dependencies..."
  # --prefer-offline reuses the cached store; plain install (not --frozen-lockfile)
  # so the cached container layer keeps working across small lockfile drift.
  pnpm install --prefer-offline
else
  echo "[session-start] pnpm workspace not found; skipping"
fi

# --- Python: HandiEdge Engine ----------------------------------------------
ENGINE_DIR="$REPO_ROOT/handiedge_engine"
if [ -f "$ENGINE_DIR/pyproject.toml" ]; then
  echo "[session-start] installing HandiEdge Engine (dev + xgboost extras)..."
  # dev  -> pytest, pytest-cov, httpx, ruff, mypy
  # xgboost -> production prediction adapter (xgboost, numpy)
  python3 -m pip install --quiet --disable-pip-version-check -e "${ENGINE_DIR}[dev,xgboost]"

  # Fail fast and loudly if the toolchain is not actually importable.
  python3 - <<'PY'
import importlib
import sys

required = ["fastapi", "pydantic", "sqlalchemy", "alembic", "typer", "structlog",
            "pytest", "httpx", "xgboost", "numpy", "app.main"]
missing = []
for module in required:
    try:
        importlib.import_module(module)
    except Exception as exc:  # noqa: BLE001 - report every failure at once
        missing.append(f"{module} ({exc.__class__.__name__}: {exc})")
if missing:
    print("[session-start] MISSING: " + "; ".join(missing), file=sys.stderr)
    sys.exit(1)
print("[session-start] python toolchain verified")
PY
else
  echo "[session-start] handiedge_engine not found; skipping Python setup"
fi

echo "[session-start] done"
