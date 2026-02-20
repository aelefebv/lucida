# Lucida

Lucida is a contract-first, cross-platform ND microscopy viewer.

This repository now contains the Slice 0 + Slice 1 baseline:
- Rust workspace with protocol, core reducer, storage adapter, renderer stub, daemon, and app crates.
- Python SDK (`python/lucida_py`) with sync-first APIs and background event subscription.
- Local OME-Zarr fixture and scripted notebook-style demo flow.
- Dual command logs (`audit_log`, `replay_log`) with deterministic replay.

## Repository layout
- `/Users/austin/GitHub/lucida/rust`: Rust workspace.
- `/Users/austin/GitHub/lucida/python`: Python SDK + tests + examples.
- `/Users/austin/GitHub/lucida/fixtures`: tiny real OME-Zarr fixtures.
- `/Users/austin/GitHub/lucida/SPEC.md`: living product and delivery spec.

## Quickstart
1. Start daemon:
   ```bash
   cd /Users/austin/GitHub/lucida/rust
   cargo run -p lucida-daemon -- --socket /tmp/lucida.sock
   ```
2. Run scripted Slice 1 flow:
   ```bash
   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run python examples/slice1_demo.py
   ```
3. Attach desktop app to an existing session (real 2D pixels):
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
   cargo run -p lucida-app -- --socket /tmp/lucida.sock --session-id <session_id>
   ```
4. Run tests:
   ```bash
   cd /Users/austin/GitHub/lucida/rust
   cargo test --workspace

   cd /Users/austin/GitHub/lucida/python
   PYTHONPATH=/Users/austin/GitHub/lucida/python uv run pytest tests/test_slice1_e2e.py
   ```
