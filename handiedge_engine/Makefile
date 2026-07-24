.PHONY: install lint format test migrate run docker-up docker-down docker-test e2e clean

PY ?= python

install:
	$(PY) -m pip install -e ".[dev]"

lint:
	ruff check app tests

format:
	ruff check --fix app tests
	ruff format app tests

test:
	$(PY) -m pytest

migrate:
	$(PY) -m alembic upgrade head

run:
	uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

e2e:
	HANDIEDGE_DATABASE_URL=sqlite+pysqlite:///./handiedge.db $(PY) -m alembic upgrade head
	HANDIEDGE_DATABASE_URL=sqlite+pysqlite:///./handiedge.db $(PY) -m app.cli.main predict examples/control_tower_valid.json

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down -v

docker-migrate:
	docker compose run --rm api alembic upgrade head

docker-test:
	docker compose run --rm api pytest

clean:
	rm -f handiedge.db
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache .coverage
