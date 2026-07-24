# Migration Notes

## Database migrations (Alembic)

- Migrations live in `alembic/versions/`. Revision `0001_initial` creates the
  full schema from the SQLAlchemy metadata, keeping the first revision exactly in
  sync with the ORM models. **Subsequent revisions must use explicit `op.*`
  operations** (add columns, indexes, etc.) so changes are reviewable and
  reversible.
- The runtime database URL is injected from `HANDIEDGE_DATABASE_URL` in
  `alembic/env.py`; `alembic.ini` intentionally leaves `sqlalchemy.url` blank.
- SQLite uses batch mode (`render_as_batch=True`) so `ALTER TABLE` operations work
  in local/test environments; PostgreSQL is the production target.

Commands:

```bash
python -m alembic upgrade head      # apply
python -m alembic downgrade base    # tear down
python -m alembic revision -m "add X"   # author a new revision (explicit ops)
```

## SQLite → PostgreSQL migration

- SQLite is for local unit tests only. JSON columns map to generic `JSON` on
  SQLite and to `JSONB` on PostgreSQL automatically (`JSONVariant`).
- Before switching to Postgres: set `HANDIEDGE_DATABASE_URL` to a
  `postgresql+psycopg://...` URL and run `alembic upgrade head` against it.
- Foreign keys are enforced on both engines (a `PRAGMA foreign_keys=ON` hook is
  installed for SQLite).

## Data / contract versioning

- `schema_version` accompanies every Control Tower payload and run; treat schema
  changes as additive where possible and bump the version for breaking changes.
- `decision_policy_version`, `settlement_rule_version`, and `calibration_version`
  are embedded into locks and audit events so historical predictions remain
  interpretable after policy changes.
