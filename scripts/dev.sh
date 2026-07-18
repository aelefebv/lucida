#!/usr/bin/env bash
# dev.sh — bring lucida fully up to date and run both dev servers with one command.
#
# Replaces the two-terminal loop in the README. In order, it:
#   1. Preflight — verify the toolchain and report existing dev listeners.
#   2. WASM      — rebuild lucida-core's pkg when build inputs or generated
#                  artifacts differ from the last verified build (content
#                  hashes avoid mtime false positives after a checkout).
#   3. Web deps  — sync lucida-web from its frozen lockfile. The WASM package is
#                  a live link, so rebuilding it never requires reinstalling.
#   4. Server    — `cargo build -p lucida-server` (cargo tracks staleness itself).
#   5. Ports     — refuse busy listeners after builds are fresh, or replace them
#                  when explicitly requested.
#   6. Run       — start the server + Vite, stream both logs, reap both on Ctrl-C.
#
# Then open http://localhost:5173 (you land as admin dev@local; auth is
# auto-disabled on loopback per ADR-0018). By default the backend is on :9876
# and Vite proxies /auth /api /admin /ws/workspaces to it.
#
# Usage:  ./scripts/dev.sh [--wasm] [--replace] [-h|--help]
#   --wasm   force a wasm rebuild even if sources look unchanged.
#   --replace terminate listeners on the selected dev ports after rebuilding.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

# Override both ports for parallel worktrees/instances. dev.sh always binds the
# backend to loopback; Vite receives the matching target explicitly.
backend_port="${LUCIDA_DEV_BACKEND_PORT:-9876}"
web_port="${LUCIDA_DEV_WEB_PORT:-5173}"
vite_proxy_target="${LUCIDA_VITE_PROXY_TARGET:-http://127.0.0.1:${backend_port}}"
build_state_file="lucida-core/pkg/.dev-build-state"
force_wasm=0
replace_listeners=0

for arg in "$@"; do
  case "${arg}" in
    --wasm) force_wasm=1 ;;
    --replace) replace_listeners=1 ;;
    -h|--help)
      awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) printf 'dev.sh: unknown argument: %s (try --help)\n' "${arg}" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

validate_port() {
  case "$1" in
    ''|*[!0-9]*) die "$2 must be an integer TCP port; got '$1'" ;;
  esac
  local numeric=$((10#$1))
  [ "${numeric}" -ge 1 ] && [ "${numeric}" -le 65535 ] \
    || die "$2 must be between 1 and 65535; got '$1'"
}

validate_port "${backend_port}" LUCIDA_DEV_BACKEND_PORT
validate_port "${web_port}" LUCIDA_DEV_WEB_PORT
[ "${backend_port}" != "${web_port}" ] \
  || die "LUCIDA_DEV_BACKEND_PORT and LUCIDA_DEV_WEB_PORT must be different"

# --- 1. preflight -----------------------------------------------------------
say "Preflight"
for tool in cargo corepack lsof node rustc shasum wasm-pack; do
  command -v "${tool}" >/dev/null 2>&1 || die "missing required tool on PATH: ${tool}"
done
expected_node="$(tr -d '\r\n' < .node-version)"
actual_node="$(node --version)"
[ "${actual_node#v}" = "${expected_node}" ] || die "Node ${expected_node} required (.node-version); found ${actual_node#v}"
expected_pnpm="$(node -p "require('./lucida-web/package.json').packageManager.split('@').pop()")"
actual_pnpm="$(corepack pnpm --version)"
[ "${actual_pnpm}" = "${expected_pnpm}" ] || die "pnpm ${expected_pnpm} required; Corepack resolved ${actual_pnpm}"
actual_rust="$(rustc --version | awk '{print $2}')"
[ "${actual_rust}" = "1.95.0" ] || die "Rust 1.95.0 required (rust-toolchain.toml); found ${actual_rust}"
actual_wasm_pack="$(wasm-pack --version | awk '{print $2}')"
[ "${actual_wasm_pack}" = "0.15.0" ] || die "wasm-pack 0.15.0 required; found ${actual_wasm_pack}"
port_busy() {
  local output status
  # Probe the exact loopback bind the backend/Vite will request. lsof is useful
  # for ownership diagnostics, but it can hide other users' processes on
  # restricted /proc mounts; a real exclusive bind cannot report a false free.
  if output="$(node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") process.exit(10);
      console.error(error && error.message ? error.message : String(error));
      process.exit(11);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          console.error(error.message);
          process.exit(12);
        }
        process.exit(0);
      });
    });
  ' "$1" 2>&1)"; then
    return 1
  else
    status=$?
  fi
  if [ "${status}" -eq 10 ]; then
    return 0
  fi
  die "could not probe loopback TCP port $1: ${output:-exit ${status}}"
}

scan_busy_ports() {
  busy=()
  port_busy "${backend_port}" && busy+=("backend :${backend_port}")
  port_busy "${web_port}" && busy+=("web :${web_port}")
  return 0
}

show_busy_listeners() {
  local port
  for port in "${backend_port}" "${web_port}"; do
    if port_busy "${port}"; then
      lsof -nP -iTCP:"${port}" -sTCP:LISTEN >&2 \
        || warn "port :${port} is busy, but lsof could not identify its owner"
    fi
  done
  return 0
}

scan_busy_ports
if [ "${#busy[@]}" -gt 0 ]; then
  warn "existing listener(s): ${busy[*]}"
  warn "build freshness will be repaired before launch; use --replace to stop these listeners afterward."
  show_busy_listeners
fi

# --- 2. wasm (rebuild only when inputs or generated artifacts changed) -------
# The old inline pipeline swallowed every enumeration/hash error and still
# accepted whatever digest text the partial pipeline produced. That could
# persist an empty/incomplete manifest and make later Rust changes look falsely
# fresh. The helper covers workspace/root build inputs and fails closed. We
# also fingerprint the generated package: a matching source hash alone cannot
# bless stale or replaced wasm/JS/type artifacts.
if ! current_source_fingerprint="$(sh scripts/wasm-dev-fingerprint.sh source "${repo_root}")"; then
  die "could not fingerprint WASM build inputs"
fi

stored_source_fingerprint=""
stored_artifact_fingerprint=""
if [ -f "${build_state_file}" ]; then
  stored_source_fingerprint="$(sed -n 's/^source=//p' "${build_state_file}")"
  stored_artifact_fingerprint="$(sed -n 's/^artifacts=//p' "${build_state_file}")"
fi

current_artifact_fingerprint=""
if current_artifact_fingerprint="$(
  sh scripts/wasm-dev-fingerprint.sh artifacts "${repo_root}" 2>/dev/null
)"; then
  :
else
  # Missing, unreadable, or malformed output is never fresh; wasm-pack below
  # repairs it and then the unsuppressed post-build fingerprint must succeed.
  current_artifact_fingerprint=""
fi

rebuild_wasm=0
wasm_reason=""
if [ "${force_wasm}" -eq 1 ]; then
  rebuild_wasm=1
  wasm_reason="forced"
elif [ -z "${current_artifact_fingerprint}" ]; then
  rebuild_wasm=1
  wasm_reason="generated package is missing or incomplete"
elif [ "${current_source_fingerprint}" != "${stored_source_fingerprint}" ]; then
  rebuild_wasm=1
  wasm_reason="build inputs changed"
elif [ "${current_artifact_fingerprint}" != "${stored_artifact_fingerprint}" ]; then
  rebuild_wasm=1
  wasm_reason="generated package changed outside this build"
fi

if [ "${rebuild_wasm}" -eq 1 ]; then
  say "Building wasm (${wasm_reason})"
  ( cd lucida-core && wasm-pack build --target web --out-dir pkg -- --locked )
  if ! built_artifact_fingerprint="$(sh scripts/wasm-dev-fingerprint.sh artifacts "${repo_root}")"; then
    die "wasm-pack completed without the full generated package contract"
  fi
  state_tmp="${build_state_file}.tmp.$$"
  printf 'source=%s\nartifacts=%s\n' \
    "${current_source_fingerprint}" "${built_artifact_fingerprint}" > "${state_tmp}"
  mv "${state_tmp}" "${build_state_file}"
  rm -f lucida-core/pkg/.dev-src-hash
else
  say "wasm up to date — source and generated-package fingerprints match"
fi

# --- 3. web deps ------------------------------------------------------------
say "Syncing web deps from the frozen lockfile"
( cd lucida-web && corepack pnpm install --frozen-lockfile )

# --- 4. server --------------------------------------------------------------
say "Building lucida-server"
cargo build -p lucida-server

# --- 5. replace/refuse listeners only after every build is fresh ------------
scan_busy_ports
if [ "${#busy[@]}" -gt 0 ]; then
  if [ "${replace_listeners}" -ne 1 ]; then
    show_busy_listeners
    die "builds are fresh, but ${busy[*]} remain in use. Stop them or rerun with --replace."
  fi

  listener_pids="$({
    lsof -nP -t -iTCP:"${backend_port}" -sTCP:LISTEN 2>/dev/null || true
    lsof -nP -t -iTCP:"${web_port}" -sTCP:LISTEN 2>/dev/null || true
  } | LC_ALL=C sort -u)"
  if [ -z "${listener_pids}" ]; then
    die "port(s) are busy but lsof could not identify an owner; stop them manually"
  fi
  warn "terminating existing dev listener PID(s): $(printf '%s' "${listener_pids}" | tr '\n' ' ')"
  for pid in ${listener_pids}; do
    kill -TERM "${pid}" 2>/dev/null || true
  done

  # Give cooperative servers a bounded shutdown window. Do not escalate to
  # SIGKILL automatically: --replace authorizes replacing listeners, not
  # destroying an unrelated process that ignored TERM.
  for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    scan_busy_ports
    [ "${#busy[@]}" -eq 0 ] && break
    sleep 0.25
  done
  scan_busy_ports
  if [ "${#busy[@]}" -gt 0 ]; then
    show_busy_listeners
    die "listener(s) did not stop after TERM: ${busy[*]}"
  fi
fi

# --- 6. run both, reap both -------------------------------------------------
set -m   # each background job gets its own process group → clean group-kill
server_bin="target/debug/lucida-server"
pids=()

cleanup() {
  trap - INT TERM EXIT
  printf '\n'; say "Shutting down…"
  local pid
  for pid in "${pids[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  done
  sleep 1
  for pid in "${pids[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

say "Starting backend → http://127.0.0.1:${backend_port}"
LUCIDA_BIND="127.0.0.1:${backend_port}" RUST_LOG="${RUST_LOG:-info}" "${server_bin}" &
pids+=("$!")

say "Starting SPA   → http://localhost:${web_port} (proxy → ${vite_proxy_target})"
# Vite excludes the linked WASM package from dependency optimization, so it
# observes rebuilt pkg files directly and never needs cache-bypass flags.
( cd lucida-web && \
  LUCIDA_VITE_PROXY_TARGET="${vite_proxy_target}" \
  corepack pnpm run dev -- --port "${web_port}" --strictPort ) &
pids+=("$!")

printf '\n\033[1;32m✓ lucida dev is up — open http://localhost:%s\033[0m   (Ctrl-C stops both)\n\n' "${web_port}"
wait
