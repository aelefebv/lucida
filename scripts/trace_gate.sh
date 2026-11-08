#!/usr/bin/env bash
# Run `lucida trace --gate` over generated fixtures at device pixel ratio 1
# and 2, and fail if any run stalls, never settles, or carries a failing
# verdict. CI runs it nightly under SwiftShader; it runs the same against any
# server with a built web bundle.
#
# The server opens each dataset by the path the script passes, so it has to
# see the data directory at the same absolute path.
#
#   LUCIDA_GATE_SERVER   server base URL (default http://127.0.0.1:9876)
#   LUCIDA_GATE_CLI      lucida command (default `cargo run -q -p lucida-cli --`)
#   LUCIDA_GATE_DATA     absolute path fixtures are generated in, and reused from
#   LUCIDA_GATE_OUTPUT   absolute path run files and bundles go to
#   LUCIDA_GATE_TIMEOUT  seconds each run may take to settle (default 120)
#   LUCIDA_GATE_ONLY     space-separated fixture names to run, all by default
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

server="${LUCIDA_GATE_SERVER:-http://127.0.0.1:9876}"
timeout="${LUCIDA_GATE_TIMEOUT:-120}"
tmp_root="${TMPDIR:-/tmp}"
data_dir="${LUCIDA_GATE_DATA:-${tmp_root%/}/lucida-trace-gate-data}"
output_dir="${LUCIDA_GATE_OUTPUT:-$(mktemp -d "${tmp_root%/}/lucida-trace-gate.XXXXXX")}"
mkdir -p "${data_dir}" "${output_dir}"

if [[ -n "${LUCIDA_GATE_CLI:-}" ]]; then
  read -r -a lucida_cmd <<< "${LUCIDA_GATE_CLI}"
else
  lucida_cmd=(cargo run -q -p lucida-cli --)
fi
# Workspaces and runs stay out of the caller's own config and trace directory.
export LUCIDA_CONFIG_PATH="${output_dir}/config.json"
export LUCIDA_TRACE_DIR="${output_dir}"

# name|camera|generator options. Each dataset is framed whole. Sizes are large
# enough to need several levels and many chunks, and small enough to generate
# in seconds. The volume is cut by the slice camera: a software rasterizer
# takes minutes to ray-march one frame of it. `single-level` has no pyramid,
# so the server generates its coarse tier.
fixtures=(
  "image|slice|--size 2048,2048 --channels 2 --levels 4 --chunk 256"
  "volume|slice|--size 128,512,512 --channels 3 --levels 3 --chunk 64"
  "collection|slice|--tiles 12 --size 512,512 --channels 2 --levels 3 --chunk 128"
  "single-level|slice|--size 4096,4096 --levels 1 --chunk 512"
)
ratios=(1 2)

wanted() {
  [[ -z "${LUCIDA_GATE_ONLY:-}" ]] || [[ " ${LUCIDA_GATE_ONLY} " == *" $1 "* ]]
}

for fixture in "${fixtures[@]}"; do
  name="${fixture%%|*}"
  wanted "${name}" || continue
  path="${data_dir}/${name}.ome.zarr"
  if [[ ! -e "${path}/zarr.json" ]]; then
    read -r -a options <<< "${fixture##*|}"
    uv run extras/synthetic_ome_zarr.py "${path}" --overwrite "${options[@]}"
  fi
done

summary="${output_dir}/summary.md"
printf '| run | exit | seconds | result |\n| --- | --- | --- | --- |\n' > "${summary}"
failures=0
stamp="$(date +%Y%m%d-%H%M%S)"

for fixture in "${fixtures[@]}"; do
  name="${fixture%%|*}"
  wanted "${name}" || continue
  camera="${fixture#*|}"
  camera="${camera%%|*}"
  for ratio in "${ratios[@]}"; do
    run="${name}-dpr${ratio}"
    log="${output_dir}/${run}.txt"
    # The page loads the whole workspace, so each run gets one of its own.
    workspace="trace-gate-${run}-${stamp}"
    "${lucida_cmd[@]}" --server "${server}" workspace create "${workspace}" > /dev/null
    echo "::group::${run}"
    started=${SECONDS}
    set +e
    "${lucida_cmd[@]}" --server "${server}" --workspace "${workspace}" \
      trace "${data_dir}/${name}.ome.zarr" \
      --camera "${camera}" \
      --device-pixel-ratio "${ratio}" \
      --timeout-seconds "${timeout}" \
      --gate \
      --output "${output_dir}/${run}.json" \
      --bundle "${output_dir}/${run}.bundle.json" \
      > "${log}" 2>&1
    status=$?
    set -e
    seconds=$((SECONDS - started))
    cat "${log}"
    echo "::endgroup::"
    verdict="$(grep -m1 -o 'VERDICT: .*' "${log}" || true)"
    if [[ "${status}" -ne 0 ]]; then
      failures=$((failures + 1))
      reason="$(grep -m1 '^error' "${log}" || tail -n 1 "${log}")"
      echo "::error title=trace gate ${run}::${reason}"
      printf '| %s | %s | %s | %s |\n' "${run}" "${status}" "${seconds}" "${reason//|/\\|}" >> "${summary}"
    else
      printf '| %s | 0 | %s | %s |\n' "${run}" "${seconds}" "${verdict//|/\\|}" >> "${summary}"
    fi
  done
done

cat "${summary}"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "${summary}" >> "${GITHUB_STEP_SUMMARY}"
fi
echo "Runs and bundles: ${output_dir}"
if [[ "${failures}" -gt 0 ]]; then
  echo "${failures} trace gate run(s) failed." >&2
  exit 1
fi
