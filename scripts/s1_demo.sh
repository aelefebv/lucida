#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_PATH="${REPO_ROOT}/qa/reports/s1_demo_report.json"

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "missing required command: ${cmd}" >&2
    exit 1
  fi
}

require_cmd python3
require_cmd cargo
require_cmd npm

cd "${REPO_ROOT}"

echo "[S1 DEMO] running acceptance harness"
python3 qa/harness/run_s1_acceptance.py --report-path "${REPORT_PATH}"

echo "[S1 DEMO] validating acceptance markers"
python3 - "${REPORT_PATH}" <<'PY'
import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
report = json.loads(report_path.read_text(encoding="utf-8"))

required_ids = ["T-M1-01", "T-M1-02", "T-M1-03", "T-M1-04", "T-M1-05"]
status_by_id = {
    case["id"]: case["status"] for case in report.get("acceptance_cases", [])
}
missing = [test_id for test_id in required_ids if status_by_id.get(test_id) != "passed"]

if not report.get("success", False):
    raise SystemExit("acceptance harness reported failure")
if missing:
    raise SystemExit(f"missing required pass markers: {', '.join(missing)}")

print("S1_DEMO_PASS")
for test_id in required_ids:
    print(f"{test_id}: {status_by_id[test_id]}")
print(f"report: {report_path}")
PY

echo "[S1 DEMO] completed"
