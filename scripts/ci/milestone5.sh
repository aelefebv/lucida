#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

phase1_notebooks=(
  "notebooks/phase1/phase1-omezarr-open-datasetsummary.ipynb"
  "notebooks/phase1/phase1-viewstate-axis-selectors.ipynb"
  "notebooks/phase1/phase1-2d-rendering-pan-zoom-slab.ipynb"
  "notebooks/phase1/phase1-snapshot-render-api-png.ipynb"
  "notebooks/phase1/phase1-viewstate-export-import.ipynb"
)

echo "[milestone5] uv sync --dev"
uv sync --dev

echo "[milestone5] cargo test (default features)"
cargo test -p lucida-daemon

echo "[milestone5] cargo test (software path)"
cargo test -p lucida-daemon --no-default-features --features software

echo "[milestone5] full pytest with rust default backend"
uv run pytest -q

echo "[milestone5] milestone parity suite against rust backend"
uv run pytest \
  tests/python/parity/test_phase1_parity.py \
  tests/python/parity/test_milestone1_dataset_open_parity.py \
  tests/python/parity/test_milestone2_viewstate_parity.py \
  tests/python/parity/test_milestone3_render_parity.py \
  tests/python/parity/test_milestone4_export_import_parity.py \
  -q

echo "[milestone5] execute canonical phase1 notebooks"
for notebook in "${phase1_notebooks[@]}"; do
  echo "  - ${notebook}"
  uv run jupyter nbconvert --to notebook --execute --inplace "$notebook"
done
