#!/bin/sh
# Deterministic, fail-closed fingerprints for the generated web WASM package.
#
# Usage:
#   sh scripts/wasm-dev-fingerprint.sh source [repo-root]
#   sh scripts/wasm-dev-fingerprint.sh artifacts [repo-root]
#
# `source` covers every Rust source/manifest that can affect lucida-core's
# workspace build plus the pinned toolchain and this build recipe. `artifacts`
# covers the complete wasm-pack output contract. Keeping both fingerprints in
# dev.sh's state prevents either a missed input or an overwritten/stale pkg
# from being mistaken for a fresh build.
set -eu

mode="${1:-}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="${2:-$(CDPATH= cd -- "${script_dir}/.." && pwd)}"

case "${mode}" in
  source|artifacts) ;;
  *)
    printf 'usage: %s {source|artifacts} [repo-root]\n' "$0" >&2
    exit 2
    ;;
esac

cd "${repo_root}"
paths="$(mktemp "${TMPDIR:-/tmp}/lucida-wasm-paths.XXXXXX")"
sorted="$(mktemp "${TMPDIR:-/tmp}/lucida-wasm-sorted.XXXXXX")"
digests="$(mktemp "${TMPDIR:-/tmp}/lucida-wasm-digests.XXXXXX")"
cleanup() {
  rm -f "${paths}" "${sorted}" "${digests}"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

require_path() {
  if [ ! -f "$1" ]; then
    printf 'wasm fingerprint: required file is missing: %s\n' "$1" >&2
    exit 1
  fi
  printf '%s\n' "$1" >> "${paths}"
}

if [ "${mode}" = source ]; then
  # Plain newline sorting is portable to the macOS/BSD userland used by most
  # Lucida developers. Repository paths containing newlines are unsupported;
  # spaces remain safe because every read and hash invocation is quoted.
  find lucida-* -path '*/src/*' -name '*.rs' -type f -print >> "${paths}"
  find lucida-* -maxdepth 1 -name 'Cargo.toml' -type f -print >> "${paths}"
  require_path Cargo.toml
  require_path Cargo.lock
  require_path rust-toolchain.toml
  require_path scripts/dev.sh
  require_path scripts/wasm-dev-fingerprint.sh
else
  require_path lucida-core/pkg/lucida_core_bg.wasm
  require_path lucida-core/pkg/lucida_core.js
  require_path lucida-core/pkg/lucida_core.d.ts
  require_path lucida-core/pkg/lucida_core_bg.wasm.d.ts
  require_path lucida-core/pkg/package.json
fi

LC_ALL=C sort -u "${paths}" > "${sorted}"
if [ ! -s "${sorted}" ]; then
  printf 'wasm fingerprint: no %s inputs were found\n' "${mode}" >&2
  exit 1
fi

while IFS= read -r path; do
  [ -n "${path}" ] || continue
  shasum -a 256 "${path}"
done < "${sorted}" > "${digests}"

digest_line="$(shasum -a 256 "${digests}")"
fingerprint="${digest_line%% *}"
if [ "${#fingerprint}" -ne 64 ]; then
  printf 'wasm fingerprint: invalid digest output\n' >&2
  exit 1
fi
printf '%s\n' "${fingerprint}"
