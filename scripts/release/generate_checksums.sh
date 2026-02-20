#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="${DIST_DIR:-${ROOT_DIR}/dist/release}"
PY_DIST_DIR="${PY_DIST_DIR:-${ROOT_DIR}/dist/python}"
OUTPUT_FILE="${OUTPUT_FILE:-${DIST_DIR}/SHA256SUMS}"

mkdir -p "$(dirname "${OUTPUT_FILE}")"

if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD="shasum -a 256"
else
  echo "missing required checksum command (sha256sum or shasum)"
  exit 1
fi

mapfile -t FILES < <(
  {
    find "${DIST_DIR}" -maxdepth 1 -type f ! -name "SHA256SUMS" -print
    find "${PY_DIST_DIR}" -maxdepth 1 -type f -print 2>/dev/null || true
  } | sort
)

if [[ "${#FILES[@]}" -eq 0 ]]; then
  echo "no release files found under ${DIST_DIR} or ${PY_DIST_DIR}"
  exit 1
fi

: >"${OUTPUT_FILE}"
for file in "${FILES[@]}"; do
  if [[ "${HASH_CMD}" == "sha256sum" ]]; then
    sha256sum "${file}" >>"${OUTPUT_FILE}"
  else
    shasum -a 256 "${file}" >>"${OUTPUT_FILE}"
  fi
done

echo "${OUTPUT_FILE}"
