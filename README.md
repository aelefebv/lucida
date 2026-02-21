# Lucida

Lucida is a contract-first, cross-platform ND microscopy viewer.

This repository now contains the Slice 0 + Slice 1 baseline plus Slice 2B real-3D mode and Slice 3A data/layout hardening:
- Rust workspace with protocol, core reducer, storage adapter, renderer stub, daemon, and app crates.
- Python SDK (`python/lucida_py`) with sync-first APIs and background event subscription.
- Local OME-Zarr fixtures and scripted notebook-style demo flow.
- Explicit daemon-owned render modes (`2d`, `2d_stub`, `3d`, `graph_stub`) with real dataset-backed 3D frames in `3d`.
- Hard break: `3d_stub` is no longer accepted and returns `invalid render mode: 3d_stub`.
- Pixel-correct 2D camera transform path: daemon returns raw `u16` slice payloads for fixed `t/c/z`, app applies zoom/pan transform locally.
- In `3d`, daemon now returns raw MIP `u16` intensities and contrast is applied once in the app shader.
- Slice 2B.4 adds brick-majorant acceleration in daemon 3D raymarch, plus skip diagnostics (`skip`, `bt`, `bs`, `samples`) in app HUD/title.
- Slice 2B.4 adds adaptive interactive 3D request cap tuning from daemon `raymarch_ms` (bounded `360..640`) with full-resolution restore on settle.
- Slice 2B.5 adds daemon row-parallel 3D raymarch (`rayon`) and app async frame scheduling (single in-flight + latest-wins) so heavy close-volume frames do not block input/rendering.
- Slice 2B.5 extends HUD diagnostics with frame-worker state (`in-flight`, `pending-latest`, `dropped-stale`) and daemon parallel metadata (`par`, `workers`, `rows`).
- Slice 3A adds a typed storage layout resolver that canonicalizes axes, enforces user remaps in actual chunk addressing, supports implicit singleton `t/c`, and exposes normalized layout metadata (`layout_version`, `canonical_axes`, `canonical_to_source_dim`, `implicit_singleton_axes`, `spatial_scale_zyx`).
- Slice 3A adds explicit OME-Zarr 0.4 best-effort adapter handling with fail-fast ambiguity errors, plus 3D anisotropy enforcement from metadata-derived voxel scales.
- Daemon-owned per-image render state (`sampling_mode`, `contrast_limits`) exposed via RPC and replay logs.
- Dual command logs (`audit_log`, `replay_log`) with deterministic replay.

## Repository layout
- `/Users/austin/GitHub/lucida/rust`: Rust workspace.
- `/Users/austin/GitHub/lucida/python`: Python SDK + tests + examples.
- `/Users/austin/GitHub/lucida/fixtures`: tiny + structured real OME-Zarr fixtures.
- `/Users/austin/GitHub/lucida/SPEC.md`: living product and delivery spec.

## Quickstart
1. Start daemon:
   ```bash
   cd /Users/austin/GitHub/lucida/rust
   cargo run --release -p lucida-daemon -- --socket /tmp/lucida.sock
   ```
2. Run scripted Slice 1 flow:
   ```bash
   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python examples/slice1_demo.py
   ```
3. Generate deterministic fixtures (one-time or when changed):
   ```bash
   cd /Users/austin/GitHub/lucida
   python3 fixtures/generate_structured_3d_fixture.py
   python3 fixtures/generate_slice3a_fixtures.py
   ```
4. Attach desktop app to an existing session (real 2D + real 3D + graph stub):
   ```bash
   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python - <<'PY'
from pathlib import Path
from lucida_py import LucidaClient

root = Path('/Users/austin/GitHub/lucida')
socket = '/tmp/lucida.sock'
client = LucidaClient.connect(socket_path=socket)
session_id = client.session.create()
client.dataset.open(session_id=session_id, uri=str(root / 'fixtures' / 'ome_zarr_v05_min'))
client.layer.add_image(session_id=session_id, layer_id='image-1', channel=0)
print(session_id)
PY
   ```
   Then launch the app with that `session_id`:
   ```bash
   cd /Users/austin/GitHub/lucida/rust
   cargo run --release -p lucida-app -- --socket /tmp/lucida.sock --session-id <session_id>
   ```
   In app: `1/2/3/4` switch render modes (`2d` / `3d` / `graph_stub` / `2d_stub`), up/down or `[`/`]` (or PgUp/PgDn) step `z`, left/right step `c`, `,/.` step `t`, `M` toggles sampling (`nearest` / `linear`) through daemon RPC, `C` auto-contrast, `V` reset contrast to full range, `Z/X` narrow/widen contrast window. In `2d`: mouse wheel = cursor-anchored zoom, left-drag = pan. In `3d`: left-drag = mouse look, wheel = speed scale, `R` reset pose, `WASD` move forward/left/back/right, `E/Q` up/down, `I/J/K/L` pitch/yaw, `U/O` roll, `+/-` speed.
   Entering `3d` runs a one-shot shared bootstrap (canonical freefly pose + robust `(1,99)` contrast from the first 3D frame) unless both camera and contrast already appear user-tuned.
5. Run dedicated real-3D demo setup:
   ```bash
   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python examples/slice2_real_3d_demo.py
   ```
6. Run Slice 3A layout/anisotropy demo setup:
   ```bash
   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python examples/slice3a_layout_demo.py
   ```
7. Run multi-`t`/multi-`c` 3D demo setup:
   ```bash
   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python examples/slice3_tc_3d_demo.py
   ```
8. Generate and run a big multi-chunk 3D fixture (optional stress pass):
   ```bash
   cd /Users/austin/GitHub/lucida
   # Example close to "large but still practical":
   # shape 6x6x500x500x500, chunked as [1,1,50,50,50] (~8.38 GiB raw)
   python3 fixtures/generate_big_tc_3d_fixture.py \
     --output /tmp/lucida_ome_zarr_v05_big_tc_3d \
     --t 6 --c 6 --z 500 --y 500 --x 500 \
     --chunk-z 50 --chunk-y 50 --chunk-x 50 \
     --force

   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python examples/slice3_big_tc_3d_demo.py --fixture /tmp/lucida_ome_zarr_v05_big_tc_3d
   ```
9. Run tests:
   ```bash
   cd /Users/austin/GitHub/lucida/rust
   cargo test --workspace

   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run pytest tests/test_slice1_e2e.py
   ```

## 3D performance baseline
1. Use release builds for both daemon and app, debug builds are intentionally slower and not representative for 3D performance acceptance.
2. Use the structured fixture and `examples/slice2_real_3d_demo.py`, then attach the app command it prints.
3. In `3d`, hold movement keys and mouse-look to validate interactive FPS, then stop input and confirm quality returns to full detail shortly after idle.
4. While navigating close to the volume, watch HUD/title fields: `skip`, `bt`, `bs`, and `samples`. Non-zero skip with `bs < bt` indicates empty-space/majorant skipping is active.
5. For spike validation, move inside dense structures while rotating (`WASD` + left-drag + `U/O`); expect interaction to stay responsive without hard UI stalls, while HUD shows worker coalescing under load (`WK:IF1`, `P1` transiently, and increasing `DS` when stale frames are dropped).
6. For heavy close-up motion, `raymarch_ms` should generally stay under ~250ms in release mode; if it exceeds this briefly, UI should still remain interactive because frame fetch runs off the UI thread.
