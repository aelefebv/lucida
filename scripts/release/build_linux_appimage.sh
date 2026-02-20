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

if [[ -z "${RELEASE_TAG_VALUE}" ]]; then
  echo "missing release tag (set RELEASE_TAG, GITHUB_REF_NAME, or pass as arg1)"
  exit 1
fi

eval "$(${ROOT_DIR}/scripts/release/parse_tag_version.py --tag "${RELEASE_TAG_VALUE}" --format env)"

mkdir -p "${DIST_DIR}"
ARTIFACT_PATH="${DIST_DIR}/lucida-render-shell-v${RELEASE_SEMVER}-linux-x86_64.AppImage"

if [[ "${DRY_RUN}" == "1" ]]; then
  printf '#!/usr/bin/env sh\necho dry-run placeholder for %s\n' "${ARTIFACT_PATH}" >"${ARTIFACT_PATH}"
  chmod +x "${ARTIFACT_PATH}"
  echo "${ARTIFACT_PATH}"
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "build_linux_appimage.sh must run on Linux"
  exit 1
fi

require_cmd cargo
require_cmd appimagetool

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
APP_DIR="${WORK_DIR}/AppDir"
mkdir -p "${APP_DIR}/usr/bin"
cp "${BIN_PATH}" "${APP_DIR}/usr/bin/lucida-render-shell"
chmod +x "${APP_DIR}/usr/bin/lucida-render-shell"

cat >"${APP_DIR}/AppRun" <<'APP'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${HERE}/usr/bin/lucida-render-shell" "$@"
APP
chmod +x "${APP_DIR}/AppRun"

cat >"${APP_DIR}/lucida-render-shell.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Lucida Render Shell
Exec=lucida-render-shell
Icon=lucida-render-shell
Categories=Science;Graphics;
Terminal=false
DESKTOP

# 1x1 transparent PNG.
cat >"${APP_DIR}/lucida-render-shell.png" <<'PNGDATA'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XnFQAAAAASUVORK5CYII=
PNGDATA
base64 -d "${APP_DIR}/lucida-render-shell.png" >"${APP_DIR}/.icon.tmp"
mv "${APP_DIR}/.icon.tmp" "${APP_DIR}/lucida-render-shell.png"
ln -sf "lucida-render-shell.png" "${APP_DIR}/.DirIcon"

cleanup() {
  if [[ -n "${GNUPGHOME:-}" && -d "${GNUPGHOME}" ]]; then
    rm -rf "${GNUPGHOME}"
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

appimagetool "${APP_DIR}" "${ARTIFACT_PATH}"
chmod +x "${ARTIFACT_PATH}"

if [[ "${UNSIGNED}" != "1" ]]; then
  require_cmd gpg
  require_env APPIMAGE_GPG_PRIVATE_KEY_ASC
  require_env APPIMAGE_GPG_PASSPHRASE

  export GNUPGHOME="$(mktemp -d)"
  KEY_FILE="${WORK_DIR}/appimage.key.asc"
  printf '%s\n' "${APPIMAGE_GPG_PRIVATE_KEY_ASC}" >"${KEY_FILE}"
  gpg --batch --import "${KEY_FILE}"
  gpg --batch --yes --pinentry-mode loopback \
    --passphrase "${APPIMAGE_GPG_PASSPHRASE}" \
    --armor --detach-sign \
    --output "${ARTIFACT_PATH}.asc" \
    "${ARTIFACT_PATH}"
  gpg --verify "${ARTIFACT_PATH}.asc" "${ARTIFACT_PATH}"
fi

echo "${ARTIFACT_PATH}"
