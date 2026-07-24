"""initial schema

Creates all HandiEdge Engine tables from the SQLAlchemy metadata. Using the
declarative metadata keeps this first revision in exact sync with the ORM models;
subsequent revisions should use explicit ``op`` operations.

Revision ID: 0001_initial
Revises:
Create Date: 2026-01-01 00:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

from app.infrastructure.database import models  # noqa: F401  (register tables)
from app.infrastructure.database.base import Base

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
