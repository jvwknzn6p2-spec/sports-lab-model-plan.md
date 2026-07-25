#!/usr/bin/env bash
# End-to-end AI Sports Lab pipeline over the recorded fixtures.
#
# Chains all seven components across the hybrid stack:
#   Python : train -> predict            (Engine + Ensemble + Calibration)
#   TS     : lock  (runs AI review)      (AI Multi-Agent Review + Prediction Lock)
#   TS     : settle                      (Settlement)
#   Python : analyze -> learn            (Error Analysis + Self-Learning)
#
# Uses fixtures (SPORTSLAB_USE_FIXTURES=1) because this environment's egress
# blocks the live data APIs. Set SPORTSLAB_USE_FIXTURES=0 where they're reachable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$ROOT/prediction-engine"
OUT="$ENGINE/out"
DATE="${1:-2026-07-25}"
RESULTS="$ENGINE/src/sportslab_engine/ingest/fixtures/results_${DATE}.json"

export PYTHONPATH="$ENGINE/src"
export SPORTSLAB_USE_FIXTURES=1
export SPORTSLAB_NOW="${DATE}T18:00:00Z"   # deterministic clock for review staleness

echo "== [1/6] train (Prediction Engine + calibration) =="
python3 -m sportslab_engine.cli train

echo "== [2/6] predict (Ensemble + Calibration -> GamePrediction JSON) =="
python3 -m sportslab_engine.cli predict --date "$DATE"

echo "== [3/6] lock (AI Multi-Agent Review + Prediction Lock) =="
pnpm --filter @workspace/pipeline exec tsx src/cli.ts lock \
  --predictions "$OUT/predictions_${DATE}.json" \
  --out "$OUT/locked_${DATE}.json"

echo "== [4/6] settle (Settlement Engine) =="
pnpm --filter @workspace/pipeline exec tsx src/cli.ts settle \
  --locked "$OUT/locked_${DATE}.json" \
  --results "$RESULTS" \
  --out "$OUT/settled_${DATE}.json"

echo "== [5/6] analyze (Error Analysis Engine) =="
python3 -m sportslab_engine.cli analyze --settled "$OUT/settled_${DATE}.json"

echo "== [6/6] learn (Self-Learning Engine -> updated ensemble weights) =="
python3 -m sportslab_engine.cli learn --report "$OUT/error_report_${DATE}.json"

echo
echo "Pipeline complete. Artifacts in $ENGINE/artifacts, outputs in $OUT."
