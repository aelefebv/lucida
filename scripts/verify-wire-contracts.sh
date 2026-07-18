#!/bin/sh
# One reviewable entry point for every maintained cross-language wire lock.
# Dependency installation remains the caller's responsibility so CI and local
# development use their already-pinned environments.
set -eu

repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo"

cargo test --locked -p lucida-protocol
cargo test --locked -p lucida-content compact_multiscale_accept_reject_policy_matches_shared_corpus
cargo test --locked -p lucida-core protocol::tests
cargo test --locked -p lucida-server --test wire_goldens

(
  cd lucida-web
  pnpm exec vitest run \
    src/wireGoldens.test.ts \
    src/chunkFrame.test.ts \
    src/compactManifestCorpus.test.ts
)

(
  cd lucida-py
  uv run --frozen pytest -q tests/test_wire_fixtures.py
)
