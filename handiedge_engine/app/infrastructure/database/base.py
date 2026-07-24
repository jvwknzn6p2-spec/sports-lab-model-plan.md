"""SQLAlchemy declarative base and cross-dialect column types."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, MetaData, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.clock import utc_now
from app.core.ids import new_id

# JSONB on PostgreSQL, generic JSON elsewhere (e.g. SQLite for local tests).
JSONVariant = JSON().with_variant(JSONB(), "postgresql")

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class UUIDPKMixin:
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
