#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

phase1_notebooks=(
  "output/jupyter-notebook/phase1-omezarr-open-datasetsummary.ipynb"
  "output/jupyter-notebook/phase1-viewstate-axis-selectors.ipynb"
  "output/jupyter-notebook/phase1-2d-rendering-pan-zoom-slab.ipynb"
  "output/jupyter-notebook/phase1-snapshot-render-api-png.ipynb"
  "output/jupyter-notebook/phase1-viewstate-export-import.ipynb"
)

echo "[milestone5] uv sync --dev"
uv sync --dev

echo "[milestone5] cargo test (default features)"
cargo test -p lucida-daemon

echo "[milestone5] cargo test (software path)"
cargo test -p lucida-daemon --no-default-features --features software

echo "[milestone5] full pytest with rust default backend"
LUCIDA_BACKEND=rust uv run pytest -q

echo "[milestone5] milestone parity suite against rust backend"
LUCIDA_TEST_BACKEND=rust uv run pytest \
  tests/test_phase1_parity.py \
  tests/test_milestone1_dataset_open_parity.py \
  tests/test_milestone2_viewstate_parity.py \
  tests/test_milestone3_render_parity.py \
  tests/test_milestone4_export_import_parity.py \
  -q

echo "[milestone5] execute canonical phase1 notebooks"
for notebook in "${phase1_notebooks[@]}"; do
  echo "  - ${notebook}"
  uv run jupyter nbconvert --to notebook --execute --inplace "$notebook"
done
