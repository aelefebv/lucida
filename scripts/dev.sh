#!/usr/bin/env bash
# dev.sh — bring lucida fully up to date and run both dev servers with one command.
#
# Replaces the two-terminal loop in the README. In order, it:
#   1. Preflight — verify the toolchain and that ports 9876 / 5173 are free.
#   2. WASM      — rebuild lucida-core's wasm pkg ONLY when a lucida-* Rust
#                  source actually changed (content-hashed, so a `git checkout`
#                  that bumps mtimes does not trigger a needless rebuild).
#   3. Web deps  — `pnpm install` in lucida-web when node_modules is absent
#                  (or `--force` after a wasm rebuild, to refresh the pkg copy).
#   4. Server    — `cargo build -p lucida-server` (cargo tracks staleness itself).
#   5. Run       — start the server + Vite, stream both logs, reap both on Ctrl-C.
#
# Then open http://localhost:5173 (you land as admin dev@local; auth is
# auto-disabled on loopback per ADR-0018). The backend is on :9876 and Vite
# proxies /auth /api /admin /ws to it.
#
# Usage:  ./scripts/dev.sh [--wasm] [-h|--help]
#   --wasm   force a wasm rebuild even if sources look unchanged.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

# Ports are fixed: Vite's proxy targets :9876 and the server defaults there too.
backend_port=9876
web_port=5173
hash_file="lucida-core/pkg/.dev-src-hash"
force_wasm=0

for arg in "$@"; do
  case "${arg}" in
    --wasm) force_wasm=1 ;;
    -h|--help)
      awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) printf 'dev.sh: unknown argument: %s (try --help)\n' "${arg}" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. preflight -----------------------------------------------------------
say "Preflight"
for tool in cargo pnpm wasm-pack node; do
  command -v "${tool}" >/dev/null 2>&1 || die "missing required tool on PATH: ${tool}"
done
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
busy=()
port_busy "${backend_port}" && busy+=("backend :${backend_port}")
port_busy "${web_port}"     && busy+=("web :${web_port}")
if [ "${#busy[@]}" -gt 0 ]; then
  die "port(s) already in use: ${busy[*]} — a dev server is likely already running. Stop it first."
fi

# --- 2. wasm (rebuild only when lucida-* Rust sources actually changed) ------
# Hash the CONTENT of every workspace Rust source + manifest. The wiki gotcha
# 'wasm-rebuild-after-rust-changes' says any lucida-* crate change must trigger a
# rebuild; mtime alone lies after a git checkout, so we hash bytes, not times.
# (Cargo.lock is committed and hashed too: a dep bump changes the compiled
# wasm just like a source edit would.)
# `|| true` keeps a transient file hiccup from aborting under set -e/pipefail; an
# empty hash just falls through to the pkg-missing check below, which rebuilds.
current_hash="$(
  {
    find lucida-* -path '*/src/*' -name '*.rs' -type f -print0 2>/dev/null
    find lucida-* -maxdepth 1 -name 'Cargo.toml' -type f -print0 2>/dev/null
    find . -maxdepth 1 -name 'Cargo.lock' -type f -print0 2>/dev/null
  } | sort -z | xargs -0 shasum 2>/dev/null | shasum 2>/dev/null | awk '{print $1}'
)" || true
stored_hash=""
[ -f "${hash_file}" ] && stored_hash="$(cat "${hash_file}" 2>/dev/null || true)"

wasm_rebuilt=0
if [ "${force_wasm}" -eq 1 ] || [ ! -f lucida-core/pkg/lucida_core_bg.wasm ] || [ "${current_hash}" != "${stored_hash}" ]; then
  if   [ "${force_wasm}" -eq 1 ];                       then say "Building wasm (forced)"
  elif [ ! -f lucida-core/pkg/lucida_core_bg.wasm ];    then say "Building wasm (no pkg yet)"
  else                                                       say "Building wasm (Rust sources changed)"
  fi
  ( cd lucida-core && wasm-pack build --target web --out-dir pkg )
  printf '%s\n' "${current_hash}" > "${hash_file}"
  wasm_rebuilt=1
else
  say "wasm up to date — skipping rebuild"
fi

# --- 3. web deps ------------------------------------------------------------
if [ ! -d lucida-web/node_modules ]; then
  say "Installing web deps (node_modules missing)"
  ( cd lucida-web && pnpm install )
elif [ "${wasm_rebuilt}" -eq 1 ]; then
  say "Refreshing web deps (wasm rebuilt → re-link pkg)"
  ( cd lucida-web && pnpm install --force )
else
  say "web deps present — skipping install"
fi

# --- 4. server --------------------------------------------------------------
say "Building lucida-server"
cargo build -p lucida-server

# --- 5. run both, reap both -------------------------------------------------
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
RUST_LOG="${RUST_LOG:-info}" "${server_bin}" &
pids+=("$!")

say "Starting SPA   → http://localhost:${web_port}"
# After a wasm rebuild, pass Vite --force to clear its stale optimized-dep cache.
# (Written as an if/else rather than an array to stay safe on macOS bash 3.2,
# where expanding an empty array under `set -u` aborts the script.)
if [ "${wasm_rebuilt}" -eq 1 ]; then
  ( cd lucida-web && pnpm run dev -- --force ) &
else
  ( cd lucida-web && pnpm run dev ) &
fi
pids+=("$!")

printf '\n\033[1;32m✓ lucida dev is up — open http://localhost:%s\033[0m   (Ctrl-C stops both)\n\n' "${web_port}"
wait
