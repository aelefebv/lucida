# Testing the CLI on a Zarr File

This is a short manual smoke test for the Lucida CLI using an OME-Zarr dataset.

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
3. Start the daemon in a separate terminal (optional if using local default URL; `lucida session create` can auto-start it):
   ```bash
   cargo run -p lucida-daemon
   ```
4. Pick a dataset path:
   ```bash
   export ZARR_URI="/absolute/path/to/your-data.zarr"
   ```

If your daemon is not on the default URL (`http://127.0.0.1:3000`), add `--base-url <url>` to each command.

## Step-by-Step Smoke Test

1. Create a session (sets default `session_id` for later commands).
   ```bash
   lucida session create --json
   ```
2. Open the Zarr dataset (sets default `dataset_id`).
   ```bash
   lucida dataset open --uri "$ZARR_URI" --json
   ```
3. Create a 2D view (sets default `view_id`).
   ```bash
   lucida view create --mode 2d --width-px 768 --height-px 768 --json
   ```
4. Move to a Z slice and pan (uses default IDs).
   ```bash
   lucida view dim --axis z --index 2 --json
   lucida view pan --dx-px 20 --dy-px -15 --json
   ```
5. Save a screenshot.
   ```bash
   lucida view screenshot --width-px 512 --height-px 512 --delivery file_path --file-path cli-zarr-screenshot.png --json
   ```
6. Save a render output.
   ```bash
   lucida render image --width-px 640 --height-px 480 --delivery file_path --file-path cli-zarr-render.png --json
   ```

To inspect or reset defaults:

```bash
lucida context show
lucida context clear
```

When done, stop the managed daemon:

```bash
lucida stop
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
