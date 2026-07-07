#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

server="${LUCIDA_SMOKE_SERVER:-http://127.0.0.1:9876}"
dataset="${LUCIDA_SMOKE_DATASET:-}"
default_dataset="/Users/austin/local_data/lucida_test_zarrs/collection_a.ome.zarr"
if [[ -z "${dataset}" && -d "${default_dataset}" ]]; then
  dataset="${default_dataset}"
fi
if [[ -z "${dataset}" ]]; then
  echo "Set LUCIDA_SMOKE_DATASET to a server-visible OME-Zarr path or URL." >&2
  exit 64
fi

python_bin="${LUCIDA_SMOKE_PYTHON:-python3}"
workspace_name="${LUCIDA_SMOKE_WORKSPACE:-lucida-cli-smoke-$(date +%Y%m%d-%H%M%S)}"
output_dir="${LUCIDA_SMOKE_OUTPUT_DIR:-}"
if [[ -z "${output_dir}" ]]; then
  tmp_root="${TMPDIR:-/tmp}"
  output_dir="$(mktemp -d "${tmp_root%/}/lucida-cli-smoke.XXXXXX")"
else
  mkdir -p "${output_dir}"
fi
export LUCIDA_CONFIG_PATH="${output_dir}/config.json"

if [[ -n "${LUCIDA_SMOKE_CLI:-}" ]]; then
  read -r -a lucida_cmd <<< "${LUCIDA_SMOKE_CLI}"
else
  lucida_cmd=(cargo run -p lucida-cli --)
fi

run_cli() {
  printf '\n$'
  printf ' %q' "${lucida_cmd[@]}" --server "${server}" "$@"
  printf '\n'
  "${lucida_cmd[@]}" --server "${server}" "$@"
}

capture_json() {
  local output_path="$1"
  shift
  printf '\n$'
  printf ' %q' "${lucida_cmd[@]}" --server "${server}" --json "$@"
  printf ' > %q\n' "${output_path}"
  "${lucida_cmd[@]}" --server "${server}" --json "$@" > "${output_path}"
}

capture_json_error() {
  local output_path="$1"
  shift
  local stdout_path="${output_path%.json}.stdout"
  local stderr_path="${output_path%.json}.stderr"
  printf '\n$'
  printf ' %q' "${lucida_cmd[@]}" --server "${server}" --json "$@"
  printf ' 2> %q\n' "${stderr_path}"
  set +e
  "${lucida_cmd[@]}" --server "${server}" --json "$@" > "${stdout_path}" 2> "${stderr_path}"
  local status=$?
  set -e
  if [[ "${status}" -eq 0 ]]; then
    echo "Expected command to fail, but it succeeded: $*" >&2
    cat "${stdout_path}" >&2
    exit 1
  fi
  "${python_bin}" - "${stderr_path}" "${output_path}" <<'PY'
import json
import sys

stderr_path, output_path = sys.argv[1], sys.argv[2]
text = open(stderr_path, encoding="utf-8").read()
decoder = json.JSONDecoder()
payload = None
for index, char in enumerate(text):
    if char != "{":
        continue
    try:
        candidate, end = decoder.raw_decode(text[index:])
    except json.JSONDecodeError:
        continue
    if isinstance(candidate, dict) and "error" in candidate:
        payload = candidate
if payload is None:
    raise SystemExit(f"stderr did not contain a JSON error envelope: {stderr_path}")
with open(output_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
}

json_value() {
  local path="$1"
  local expression="$2"
  "${python_bin}" - "${path}" "${expression}" <<'PY'
import json
import sys

path, expression = sys.argv[1], sys.argv[2]
value = json.load(open(path, encoding="utf-8"))
for part in expression.split("."):
    if part.isdigit():
        value = value[int(part)]
    else:
        value = value[part]
print(value)
PY
}

echo "Lucida CLI smoke"
echo "Server: ${server}"
echo "Dataset: ${dataset}"
echo "Workspace: ${workspace_name}"
echo "Output: ${output_dir}"
echo "Config: ${LUCIDA_CONFIG_PATH}"

run_cli status
capture_json "${output_dir}/workspace-create.json" workspace create "${workspace_name}"
workspace_id="$(json_value "${output_dir}/workspace-create.json" "workspace.id")"
run_cli workspace use "${workspace_id}"
capture_json "${output_dir}/workspace-info.json" workspace info "${workspace_id}"
run_cli workspace open "${workspace_id}" --no-browser

capture_json "${output_dir}/dataset-open.json" dataset open "${dataset}"
dataset_id="$(json_value "${output_dir}/dataset-open.json" "dataset.workspace_dataset_id")"
capture_json "${output_dir}/dataset-list.json" dataset list
capture_json "${output_dir}/dataset-info.json" dataset info "${dataset_id}"
capture_json "${output_dir}/dataset-health.json" dataset health "${dataset_id}"
capture_json "${output_dir}/dataset-health-all.json" dataset health

missing_dataset="${output_dir}/missing-dataset-does-not-exist.ome.zarr"
capture_json_error "${output_dir}/dataset-open-missing-error.json" dataset open "${missing_dataset}"
"${python_bin}" - "${output_dir}/dataset-open-missing-error.json" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
error = payload["error"]
diagnostic = error.get("diagnostic")
if not isinstance(diagnostic, dict):
    raise SystemExit("missing dataset open did not include a structured diagnostic")
if diagnostic.get("stage") != "backend_open":
    raise SystemExit(f"missing dataset failed at unexpected stage: {diagnostic.get('stage')}")
if diagnostic.get("kind") not in {"local_path", "missing_object"}:
    raise SystemExit(f"missing dataset produced unexpected kind: {diagnostic.get('kind')}")
PY

malformed_dataset="${output_dir}/malformed.ome.zarr"
mkdir -p "${malformed_dataset}"
printf '{' > "${malformed_dataset}/zarr.json"
capture_json_error "${output_dir}/dataset-open-malformed-error.json" dataset open "${malformed_dataset}"
"${python_bin}" - "${output_dir}/dataset-open-malformed-error.json" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
diagnostic = payload["error"].get("diagnostic")
if not isinstance(diagnostic, dict):
    raise SystemExit("malformed dataset open did not include a structured diagnostic")
if diagnostic.get("stage") != "metadata_import":
    raise SystemExit(f"malformed dataset failed at unexpected stage: {diagnostic.get('stage')}")
if diagnostic.get("kind") != "malformed_metadata":
    raise SystemExit(f"malformed dataset produced unexpected kind: {diagnostic.get('kind')}")
PY

capture_json "${output_dir}/viewer-state-initial.json" viewer state
capture_json "${output_dir}/view-pan.json" view pan --dx 32 --dy=-16
capture_json "${output_dir}/view-zoom.json" view set-zoom --value 1.25
capture_json "${output_dir}/view-slice-z.json" view slice z 0
capture_json "${output_dir}/channel-mode.json" channel mode multi
capture_json "${output_dir}/layer-list.json" layer list
capture_json "${output_dir}/layer-opacity.json" layer opacity "${dataset_id}" 0.85
capture_json "${output_dir}/channel-colormap.json" channel colormap "${dataset_id}" 0 magenta
capture_json "${output_dir}/channel-contrast.json" channel contrast --min 0 --max 4096 "${dataset_id}" 0
capture_json "${output_dir}/viewer-state-final.json" viewer state
capture_json "${output_dir}/debug-state.json" debug state
capture_json "${output_dir}/visible-chunks.json" plan visible-chunks "${dataset_id}"

if [[ "${LUCIDA_SMOKE_CAPTURE:-1}" != "0" ]]; then
  capture_timeout="${LUCIDA_SMOKE_CAPTURE_TIMEOUT_SECONDS:-60}"
  screenshot="${output_dir}/viewer-screenshot.png"
  overview="${output_dir}/viewer-overview.png"
  run_cli viewer screenshot "${screenshot}" --width 900 --height 650 --timeout-seconds "${capture_timeout}"
  "${python_bin}" "${script_dir}/assert_png_nonblank.py" "${screenshot}"
  run_cli viewer overview "${overview}" --width 900 --height 650 --timeout-seconds "${capture_timeout}"
  "${python_bin}" "${script_dir}/assert_png_nonblank.py" "${overview}"
else
  echo "Skipping screenshot/overview capture because LUCIDA_SMOKE_CAPTURE=0."
fi

cat <<EOF

Smoke passed.
Workspace ID: ${workspace_id}
Dataset ID: ${dataset_id}
Browser URL: ${server%/}/w/${workspace_id}
Artifacts: ${output_dir}
EOF
