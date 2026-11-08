#!/usr/bin/env bash
# Run the perf runner's `gate` suite with `lucida trace --gate` at device pixel
# ratio 1 and 2, and fail if any run stalls, never settles, or carries a
# failing verdict. CI runs it under SwiftShader. The suite's datasets and
# framing are in scripts/perf/, and docs/perf.md describes them. Arguments
# pass through to scripts/perf.py.
#
#   LUCIDA_GATE_SERVER   a running server to drive; by default the runner
#                        builds and starts its own. It opens each dataset by
#                        the path the runner names, so it has to see the data
#                        directory at the same absolute path.
#   LUCIDA_GATE_CLI      a built lucida CLI; by default the runner builds one
#   LUCIDA_GATE_DATA     absolute path datasets are generated in, and reused from
#   LUCIDA_GATE_OUTPUT   absolute path run files, bundles and the summary go to
#   LUCIDA_GATE_TIMEOUT  seconds each run may take to settle (default 120)
#   LUCIDA_GATE_ONLY     space-separated dataset names to run, all by default
set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/.."

args=(--suite gate --gate --bundle --timeout-seconds "${LUCIDA_GATE_TIMEOUT:-120}")
if [[ -n "${LUCIDA_GATE_SERVER:-}" ]]; then args+=(--server "${LUCIDA_GATE_SERVER}"); fi
if [[ -n "${LUCIDA_GATE_CLI:-}" ]]; then args+=(--cli "${LUCIDA_GATE_CLI}"); fi
if [[ -n "${LUCIDA_GATE_DATA:-}" ]]; then args+=(--data "${LUCIDA_GATE_DATA}"); fi
if [[ -n "${LUCIDA_GATE_OUTPUT:-}" ]]; then args+=(--output "${LUCIDA_GATE_OUTPUT}"); fi
for dataset in ${LUCIDA_GATE_ONLY:-}; do args+=(--dataset "${dataset}"); done

exec uv run scripts/perf.py "${args[@]}" "$@"
