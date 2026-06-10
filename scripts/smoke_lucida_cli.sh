#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

server="${LUCIDA_SMOKE_SERVER:-http://127.0.0.1:9876}"
dataset="${LUCIDA_SMOKE_DATASET:-}"
default_dataset="/Users/austin/local_data/lucida_test_zarrs/20250925_CPPX245_ISR_Washout_v4.ome.zarr"
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
