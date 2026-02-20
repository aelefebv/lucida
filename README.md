# Lucida

Lucida is a contract-first, cross-platform ND microscopy viewer.

This repository now contains the Slice 0 + Slice 1 baseline plus Slice 2B real-3D mode:
- Rust workspace with protocol, core reducer, storage adapter, renderer stub, daemon, and app crates.
- Python SDK (`python/lucida_py`) with sync-first APIs and background event subscription.
- Local OME-Zarr fixtures and scripted notebook-style demo flow.
- Explicit daemon-owned render modes (`2d`, `2d_stub`, `3d`, `graph_stub`) with real dataset-backed 3D frames in `3d`.
- Hard break: `3d_stub` is no longer accepted and returns `invalid render mode: 3d_stub`.
- Pixel-correct 2D camera transform path: daemon returns raw `u16` slice payloads for fixed `t/c/z`, app applies zoom/pan transform locally.
- In `3d`, daemon now returns raw MIP `u16` intensities and contrast is applied once in the app shader.
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
3. Generate the deterministic structured 3D fixture (one-time or when changed):
   ```bash
   cd /Users/austin/GitHub/lucida
   python3 fixtures/generate_structured_3d_fixture.py
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
   In app: `1/2/3/4` switch render modes (`2d` / `3d` / `graph_stub` / `2d_stub`), arrows or `[`/`]` (or PgUp/PgDn) step `z`, `M` toggles sampling (`nearest` / `linear`) through daemon RPC, `C` auto-contrast, `V` reset contrast to full range, `Z/X` narrow/widen contrast window. In `2d`: mouse wheel = cursor-anchored zoom, left-drag = pan. In `3d`: left-drag = mouse look, wheel = speed scale, `R` reset pose, `WASD` move forward/left/back/right, `E/Q` up/down, `I/J/K/L` pitch/yaw, `U/O` roll, `+/-` speed.
   Entering `3d` runs a one-shot shared bootstrap (canonical freefly pose + robust `(1,99)` contrast from the first 3D frame) unless both camera and contrast already appear user-tuned.
5. Run dedicated real-3D demo setup:
   ```bash
   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python examples/slice2_real_3d_demo.py
   ```
6. Run tests:
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
