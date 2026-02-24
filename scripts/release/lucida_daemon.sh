#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

target_triple="$(rustc -vV | awk '/^host: / { print $2 }')"
bin_name="lucida-daemon"
artifact_name="lucida-daemon-${target_triple}"
if [[ "$target_triple" == *"-windows-"* ]]; then
  bin_name="lucida-daemon.exe"
  artifact_name="${artifact_name}.exe"
fi

echo "Building release binary for ${target_triple}..."
cargo build -p lucida-daemon --release --locked

source_bin="$repo_root/target/release/${bin_name}"
if [[ ! -f "$source_bin" ]]; then
  echo "expected binary not found: ${source_bin}" >&2
  exit 1
fi

release_dir="$repo_root/output/releases"
mkdir -p "$release_dir"

artifact_path="$release_dir/$artifact_name"
cp "$source_bin" "$artifact_path"

checksum_path="${artifact_path}.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$release_dir"
    sha256sum "$artifact_name" > "$(basename "$checksum_path")"
  )
elif command -v shasum >/dev/null 2>&1; then
  (
    cd "$release_dir"
    shasum -a 256 "$artifact_name" > "$(basename "$checksum_path")"
  )
else
  echo "no SHA-256 tool found (expected sha256sum or shasum)." >&2
  exit 1
fi

echo "Release artifact: $artifact_path"
echo "Checksum file:    $checksum_path"
