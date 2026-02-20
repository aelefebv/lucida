#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_TAG_VALUE="${RELEASE_TAG:-${GITHUB_REF_NAME:-${1:-}}}"
PY_DIST_DIR="${PY_DIST_DIR:-${ROOT_DIR}/dist/python}"
DRY_RUN="${DRY_RUN:-0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1"
    exit 1
  fi
}

if [[ -z "${RELEASE_TAG_VALUE}" ]]; then
  echo "missing release tag (set RELEASE_TAG, GITHUB_REF_NAME, or pass as arg1)"
  exit 1
fi

eval "$(${ROOT_DIR}/scripts/release/parse_tag_version.py --tag "${RELEASE_TAG_VALUE}" --format env)"

if [[ ! -d "${PY_DIST_DIR}" ]]; then
  echo "python dist directory does not exist: ${PY_DIST_DIR}"
  exit 1
fi

mapfile -t DIST_FILES < <(find "${PY_DIST_DIR}" -maxdepth 1 -type f \( -name '*.whl' -o -name '*.tar.gz' \) | sort)
if [[ "${#DIST_FILES[@]}" -eq 0 ]]; then
  echo "no wheel/sdist files found under ${PY_DIST_DIR}"
  exit 1
fi

REPO_URL="https://upload.pypi.org/legacy/"
TOKEN_VAR="PYPI_API_TOKEN"
if [[ "${RELEASE_PYPI_CHANNEL}" == "testpypi" ]]; then
  REPO_URL="https://test.pypi.org/legacy/"
  TOKEN_VAR="TEST_PYPI_API_TOKEN"
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "dry-run: would upload ${#DIST_FILES[@]} files to ${REPO_URL}"
  exit 0
fi

if [[ -z "${TWINE_USERNAME:-}" ]]; then
  export TWINE_USERNAME="__token__"
fi
if [[ -z "${TWINE_PASSWORD:-}" ]]; then
  if [[ -z "${!TOKEN_VAR:-}" ]]; then
    echo "missing credentials: set TWINE_PASSWORD or ${TOKEN_VAR}"
    exit 1
  fi
  export TWINE_PASSWORD="${!TOKEN_VAR}"
fi

TWINE_ARGS=(upload --skip-existing --repository-url "${REPO_URL}")
TWINE_ARGS+=("${DIST_FILES[@]}")

if command -v twine >/dev/null 2>&1; then
  twine "${TWINE_ARGS[@]}"
  exit 0
fi

if command -v uv >/dev/null 2>&1; then
  uv tool run --from twine twine "${TWINE_ARGS[@]}"
  exit 0
fi

echo "missing required command: twine (or uv for uv tool run --from twine)"
exit 1
