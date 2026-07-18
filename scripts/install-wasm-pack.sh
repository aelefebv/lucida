#!/bin/sh
# Install the repository-supported wasm-pack release after verifying the
# release asset against the SHA-256 digest published by upstream.
set -eu

version="v0.15.0"
install_dir="${1:-${HOME}/.cargo/bin}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    target="x86_64-unknown-linux-musl"
    expected="c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a"
    ;;
  Linux-aarch64|Linux-arm64)
    target="aarch64-unknown-linux-musl"
    expected="e17ef0806381c3a0acb9c9ddad643a49facaa5a2ecf657a421d4d8f3357a24b7"
    ;;
  Darwin-arm64|Darwin-aarch64)
    target="aarch64-apple-darwin"
    expected="0abff4a03d670b6c00ea31d0e1608a72407e355f3d3765e9c30eb45cd5b7e318"
    ;;
  Darwin-x86_64)
    target="x86_64-apple-darwin"
    expected="d3f1a4a33e95f8f0d7801b024e08624c479999ac96aa150908b2394015cd0363"
    ;;
  *)
    echo "unsupported platform for pinned wasm-pack installer: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

archive="wasm-pack-${version}-${target}.tar.gz"
directory="wasm-pack-${version}-${target}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

curl -fsSL \
  "https://github.com/wasm-bindgen/wasm-pack/releases/download/${version}/${archive}" \
  -o "${tmp}/${archive}"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${archive}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmp}/${archive}" | awk '{print $1}')"
else
  echo "no SHA-256 utility found (need sha256sum or shasum)" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "wasm-pack checksum mismatch: expected ${expected}, got ${actual}" >&2
  exit 1
fi

tar -xzf "${tmp}/${archive}" -C "$tmp"
mkdir -p "$install_dir"
install -m 0755 "${tmp}/${directory}/wasm-pack" "${install_dir}/wasm-pack"
"${install_dir}/wasm-pack" --version
