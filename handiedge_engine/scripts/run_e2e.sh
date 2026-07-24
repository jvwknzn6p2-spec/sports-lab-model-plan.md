#!/usr/bin/env bash
# End-to-end demonstration of the full HandiEdge lifecycle on SQLite.
set -euo pipefail

export HANDIEDGE_DATABASE_URL="${HANDIEDGE_DATABASE_URL:-sqlite+pysqlite:///./handiedge_e2e.db}"
rm -f ./handiedge_e2e.db

echo "== 1. migrate =="
python -m alembic upgrade head

echo "== 2. validate control tower =="
python -m app.cli.main validate-control-tower examples/control_tower_valid.json

echo "== 3. predict =="
python -m app.cli.main predict examples/control_tower_valid.json > /tmp/pred.json
PREDICTION_ID=$(python -c "import json;print(json.load(open('/tmp/pred.json'))['games'][0]['audit']['prediction_id'])")
echo "prediction_id=$PREDICTION_ID"

echo "== 4. lock =="
python -m app.cli.main lock "$PREDICTION_ID" > /tmp/lock.json
LOCK_ID=$(python -c "import json;print(json.load(open('/tmp/lock.json'))['prediction_lock_id'])")
echo "lock_id=$LOCK_ID"

echo "== 5. settle =="
python - "$LOCK_ID" <<'PY' > /tmp/settle_input.json
import json, sys
data = json.load(open("examples/settlement_input.json"))
data["prediction_lock_id"] = sys.argv[1]
print(json.dumps(data))
PY
python -m app.cli.main settle /tmp/settle_input.json > /tmp/settle.json
SETTLEMENT_ID=$(python -c "import json;print(json.load(open('/tmp/settle.json'))['settlement_id'])")
echo "settlement_id=$SETTLEMENT_ID"

echo "== 6. error analysis =="
python -m app.cli.main analyze-error "$SETTLEMENT_ID"

echo "== 7. learning workflow =="
python -m app.cli.main create-learning-workflow "$SETTLEMENT_ID" --league MLB

echo "== DONE =="
