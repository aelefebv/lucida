# Testing the CLI on a Zarr File

This is a short end-to-end smoke test for the Lucida CLI with an OME-Zarr dataset.

## Prerequisites

1. From the repo root, install deps:
   ```bash
   uv sync
   ```
2. Install the CLI once:
   ```bash
   uv tool install --editable .
   uv tool update-shell
   ```
3. Start the daemon in a separate terminal:
   ```bash
   cargo run -p lucida-daemon
   ```
4. Pick a dataset path:
   ```bash
   export ZARR_URI="/absolute/path/to/your-data.zarr"
   ```

## CLI Smoke Test

Run this from the repo root in a second terminal:

```bash
set -euo pipefail

SESSION_JSON=$(lucida session create --json)
SESSION_ID=$(printf '%s' "$SESSION_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')

DATASET_JSON=$(lucida dataset open --uri "$ZARR_URI" --session-id "$SESSION_ID" --json)
DATASET_ID=$(printf '%s' "$DATASET_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["dataset_summary"]["dataset_id"])')

VIEW_JSON=$(lucida view create --dataset-id "$DATASET_ID" --session-id "$SESSION_ID" --mode 2d --width-px 768 --height-px 768 --json)
VIEW_ID=$(printf '%s' "$VIEW_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["view_state"]["view_id"])')

lucida view dim --view-id "$VIEW_ID" --axis z --index 2 --session-id "$SESSION_ID" --json
lucida view pan --view-id "$VIEW_ID" --dx-px 20 --dy-px -15 --session-id "$SESSION_ID" --json

lucida view screenshot \
  --view-id "$VIEW_ID" \
  --session-id "$SESSION_ID" \
  --width-px 512 \
  --height-px 512 \
  --delivery file_path \
  --file-path cli-zarr-screenshot.png \
  --json

lucida render image \
  --view-id "$VIEW_ID" \
  --session-id "$SESSION_ID" \
  --width-px 640 \
  --height-px 480 \
  --delivery file_path \
  --file-path cli-zarr-render.png \
  --json
```

## Expected Results

1. `dataset open` returns a `dataset_summary` with axes and multiscales.
2. `view create` returns a `view_id`.
3. Two PNG files are written under `output/`:
   - `output/cli-zarr-screenshot.png`
   - `output/cli-zarr-render.png`

Quick file check:

```bash
ls -lh output/cli-zarr-screenshot.png output/cli-zarr-render.png
```
