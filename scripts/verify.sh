#!/bin/sh
# Local equivalent of the repository's code/test gates. Diff-only GitHub
# checks (dependency review) and multi-architecture publishing remain CI-only.
set -eu

repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo"

cargo fmt --all -- --check
cargo test --locked --workspace --all-features
cargo clippy --locked --workspace --all-features --all-targets -- -D warnings

if ! command -v wasm-pack >/dev/null 2>&1 \
  || [ "$(wasm-pack --version)" != "wasm-pack 0.15.0" ]; then
  sh scripts/install-wasm-pack.sh "${HOME}/.cargo/bin"
fi
(cd lucida-core && wasm-pack build --target web --out-dir pkg -- --locked)
(cd lucida-web && corepack pnpm install --frozen-lockfile)
(cd lucida-web && corepack pnpm exec tsc --noEmit -p tsconfig.app.json)
(cd lucida-web && corepack pnpm run lint)
(cd lucida-web && corepack pnpm test)
(cd lucida-web && corepack pnpm run build)

(cd lucida-py && uv sync --locked --python 3.12)
(cd lucida-py && uv run maturin develop)
(cd lucida-py && uv run pytest -q)

python3 scripts/test_dev_flow.py
python3 scripts/validate-delivery-contracts.py
