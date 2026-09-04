#!/usr/bin/env bash
# One remote-rates harness run against a dataset served by the latency stand-in.
#
# Usage: run_one.sh OUT_DIR SERVER_BIN DATA_ROOT DATASET [LATENCY_MS]
#   OUT_DIR     where the run's files go (access.log, rr-summary.json, screenshots)
#   SERVER_BIN  the lucida-server binary to boot
#   DATA_ROOT   directory the stand-in serves
#   DATASET     the dataset's path under DATA_ROOT, e.g. merge-sharded.ome.zarr
#   LATENCY_MS  per-request delay at the stand-in (default 80)
#
# Needs a built web dist (RR_WEB_DIST, default <repo>/lucida-web/dist) and the
# remote-rates harness's own prerequisites: system Chrome, a cached Playwright,
# uv for the Python client. See docs/research/remote-rates-harness/README.md.
set -euo pipefail
OUT=$1
SERVER_BIN=$2
DATA_ROOT=$3
DATASET=$4
LATENCY_MS=${5:-80}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
PORT=${STANDIN_PORT:-18090}

rm -rf "$OUT"
mkdir -p "$OUT"
python3 "$HERE/range_server.py" "$DATA_ROOT" "$PORT" "$LATENCY_MS" "$OUT/access.log" > "$OUT/range_server.out" 2>&1 &
RS_PID=$!
trap 'kill $RS_PID 2>/dev/null || true' EXIT
sleep 1

export RR_SERVER_BIN="$SERVER_BIN"
export RR_WEB_DIST="${RR_WEB_DIST:-$REPO/lucida-web/dist}"
export RR_SETTLE_MS=${RR_SETTLE_MS:-8000}
export RR_READY_WAIT_MS=${RR_READY_WAIT_MS:-180000}
# The stand-in is the object store; nothing here may reach a real bucket.
unset GOOGLE_APPLICATION_CREDENTIALS
cd "$REPO"
python3 docs/research/remote-rates-harness/rr_run.py "$OUT" \
  "http://127.0.0.1:$PORT/$DATASET" 2>&1 | tee "$OUT/rr_run.out" | tail -3

kill $RS_PID 2>/dev/null || true
trap - EXIT
echo "run done: $(wc -l < "$OUT/access.log") stand-in requests"
