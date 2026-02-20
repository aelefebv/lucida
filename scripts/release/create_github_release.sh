#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_TAG_VALUE="${RELEASE_TAG:-${GITHUB_REF_NAME:-${1:-}}}"
DIST_DIR="${DIST_DIR:-${ROOT_DIR}/dist/release}"
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

mapfile -t RELEASE_FILES < <(
  {
    find "${DIST_DIR}" -maxdepth 1 -type f -print 2>/dev/null || true
    find "${PY_DIST_DIR}" -maxdepth 1 -type f -print 2>/dev/null || true
  } | sort
)

if [[ "${#RELEASE_FILES[@]}" -eq 0 ]]; then
  echo "no release files found under ${DIST_DIR} and ${PY_DIST_DIR}"
  exit 1
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "dry-run: would create GitHub release ${RELEASE_TAG} with ${#RELEASE_FILES[@]} assets"
  exit 0
fi

require_cmd gh
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "missing required environment variable: GH_TOKEN"
  exit 1
fi

TITLE="Lucida v${RELEASE_SEMVER}"
NOTES_FILE="$(mktemp)"
trap 'rm -f "${NOTES_FILE}"' EXIT
cat >"${NOTES_FILE}" <<EOF
Automated release for ${RELEASE_TAG}.

- semver: ${RELEASE_SEMVER}
- python version: ${RELEASE_PYTHON_VERSION}
- channel: ${RELEASE_PYPI_CHANNEL}
EOF

CREATE_ARGS=(release create "${RELEASE_TAG}" "${RELEASE_FILES[@]}" --title "${TITLE}" --notes-file "${NOTES_FILE}" --verify-tag)
if [[ "${RELEASE_IS_PRERELEASE}" == "true" ]]; then
  CREATE_ARGS+=(--prerelease)
fi

gh "${CREATE_ARGS[@]}"
