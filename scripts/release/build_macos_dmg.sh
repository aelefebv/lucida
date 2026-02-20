#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="${DIST_DIR:-${ROOT_DIR}/dist/release}"
RELEASE_TAG_VALUE="${RELEASE_TAG:-${GITHUB_REF_NAME:-${1:-}}}"
DRY_RUN="${DRY_RUN:-0}"
UNSIGNED="${UNSIGNED:-0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1"
    exit 1
  fi
}

require_env() {
  if [[ -z "${!1:-}" ]]; then
    echo "missing required environment variable: $1"
    exit 1
  fi
}

decode_base64() {
  local input="$1"
  local output="$2"
  python3 - "$input" "$output" <<'PY'
import base64
import pathlib
import sys

encoded = sys.argv[1].encode("utf-8")
target = pathlib.Path(sys.argv[2])
target.write_bytes(base64.b64decode(encoded))
PY
}

if [[ -z "${RELEASE_TAG_VALUE}" ]]; then
  echo "missing release tag (set RELEASE_TAG, GITHUB_REF_NAME, or pass as arg1)"
  exit 1
fi

eval "$(${ROOT_DIR}/scripts/release/parse_tag_version.py --tag "${RELEASE_TAG_VALUE}" --format env)"

mkdir -p "${DIST_DIR}"
ARTIFACT_PATH="${DIST_DIR}/lucida-render-shell-v${RELEASE_SEMVER}-macos-x86_64.dmg"

if [[ "${DRY_RUN}" == "1" ]]; then
  printf 'dry-run placeholder for %s\n' "${ARTIFACT_PATH}" >"${ARTIFACT_PATH}"
  echo "${ARTIFACT_PATH}"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build_macos_dmg.sh must run on macOS"
  exit 1
fi

require_cmd cargo
require_cmd hdiutil

cargo build \
  --manifest-path "${ROOT_DIR}/rust/Cargo.toml" \
  --package lucida-render-shell \
  --bin lucida-render-shell \
  --release

BIN_PATH="${ROOT_DIR}/rust/target/release/lucida-render-shell"
if [[ ! -f "${BIN_PATH}" ]]; then
  echo "missing built binary: ${BIN_PATH}"
  exit 1
fi

WORK_DIR="$(mktemp -d)"
APP_BUNDLE="${WORK_DIR}/Lucida Render Shell.app"
mkdir -p "${APP_BUNDLE}/Contents/MacOS" "${APP_BUNDLE}/Contents/Resources"
cp "${BIN_PATH}" "${APP_BUNDLE}/Contents/MacOS/lucida-render-shell"
chmod +x "${APP_BUNDLE}/Contents/MacOS/lucida-render-shell"

cat >"${APP_BUNDLE}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Lucida Render Shell</string>
  <key>CFBundleDisplayName</key>
  <string>Lucida Render Shell</string>
  <key>CFBundleIdentifier</key>
  <string>com.lucida.render-shell</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>lucida-render-shell</string>
</dict>
</plist>
PLIST

CERT_FILE=""
KEY_FILE=""
KEYCHAIN_FILE=""
cleanup() {
  [[ -n "${CERT_FILE}" && -f "${CERT_FILE}" ]] && rm -f "${CERT_FILE}"
  [[ -n "${KEY_FILE}" && -f "${KEY_FILE}" ]] && rm -f "${KEY_FILE}"
  if [[ -n "${KEYCHAIN_FILE}" && -f "${KEYCHAIN_FILE}" ]]; then
    security delete-keychain "${KEYCHAIN_FILE}" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

if [[ "${UNSIGNED}" != "1" ]]; then
  require_cmd security
  require_cmd codesign
  require_cmd xcrun

  require_env APPLE_SIGNING_CERT_P12_BASE64
  require_env APPLE_SIGNING_CERT_PASSWORD
  require_env APPLE_SIGNING_IDENTITY
  require_env APPLE_NOTARY_KEY_ID
  require_env APPLE_NOTARY_ISSUER_ID
  require_env APPLE_NOTARY_KEY_P8_BASE64

  CERT_FILE="$(mktemp)"
  KEY_FILE="$(mktemp)"
  KEYCHAIN_FILE="$(mktemp -u /tmp/lucida-release-keychain.XXXXXX-db)"

  decode_base64 "${APPLE_SIGNING_CERT_P12_BASE64}" "${CERT_FILE}"
  decode_base64 "${APPLE_NOTARY_KEY_P8_BASE64}" "${KEY_FILE}"

  security create-keychain -p '' "${KEYCHAIN_FILE}"
  security unlock-keychain -p '' "${KEYCHAIN_FILE}"
  security set-keychain-settings -lut 21600 "${KEYCHAIN_FILE}"
  security list-keychains -d user -s "${KEYCHAIN_FILE}"
  security import "${CERT_FILE}" -k "${KEYCHAIN_FILE}" -P "${APPLE_SIGNING_CERT_PASSWORD}" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple: -s -k '' "${KEYCHAIN_FILE}"

  codesign --force --deep --options runtime --keychain "${KEYCHAIN_FILE}" --sign "${APPLE_SIGNING_IDENTITY}" "${APP_BUNDLE}"
  codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"
fi

hdiutil create \
  -volname "Lucida Render Shell" \
  -srcfolder "${APP_BUNDLE}" \
  -ov \
  -format UDZO \
  "${ARTIFACT_PATH}"

if [[ "${UNSIGNED}" != "1" ]]; then
  xcrun notarytool submit \
    "${ARTIFACT_PATH}" \
    --key "${KEY_FILE}" \
    --key-id "${APPLE_NOTARY_KEY_ID}" \
    --issuer "${APPLE_NOTARY_ISSUER_ID}" \
    --wait
  xcrun stapler staple "${ARTIFACT_PATH}"
  xcrun stapler validate "${ARTIFACT_PATH}"
fi

echo "${ARTIFACT_PATH}"
