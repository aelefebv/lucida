# Lucida SPEC Plan

## Summary
1. Build Lucida as a cross-platform desktop ND microscopy viewer with a Rust core and Python SDK.
2. Includes 2D, 3D, and ND graph visualization, not just 2D-first.
3. OME-Zarr is the primary storage format, with local, HTTP(S), and GCS support.
4. Every user action is API-addressable and replayable through a command log.
5. Browser access via remote gateway.
6. The living spec artifact will be `/Users/austin/GitHub/lucida/SPEC.md`.

## Product goals
1. Fast and responsive interaction with terabyte-scale microscopy datasets.
2. Lean dependency footprint with minimal runtime bloat.
3. Reliable cross-platform behavior on Windows, macOS, and Linux.
4. Script-first architecture for notebooks and automation workflows.
5. Strong handling of anisotropy, axis remapping, channels, and time.

## Non-goals for v1
1. Multi-tenant production SaaS security model.
2. Full Napari-style plugin ecosystem.
3. In-app heavy analytics (clustering/embedding pipelines).

## Public APIs, interfaces, and types
### Control protocol
1. JSON-RPC 2.0 is the control protocol.
2. Default transport is local IPC (Unix sockets on macOS/Linux, named pipes on Windows).
3. Optional remote mode uses TCP/WebSocket with token auth and TLS guidance.

### Python SDK (`pip`)
1. `LucidaClient.connect(...)` and `LucidaClient.launch_or_connect(...)`.
2. `session.create(...)` and `session.close(...)`.
3. `dataset.open(uri, axis_map=..., read_only=True)` and `dataset.close(...)`.
4. `layer.add_image(...)`, `layer.add_points(...)`, `layer.update(...)`, `layer.remove(...)`.
5. `view.set_axis(axis, index)`, `view.reorder_axes(order)`, `view.set_channel_order(order)`.
6. `camera.set_mode("panzoom"|"arcball"|"freefly")`, `camera.set_pose(...)`.
7. `events.subscribe(...)` for state/perf/errors/selections.
8. `command_log.export(...)`, `command_log.import(...)`, `command_log.replay(...)`.

### Canonical core types
1. `AxisLabel`: canonical labels (`t`, `c`, `z`, `y`, `x`, plus extra labels).
2. `AxisSpec`: label, size, unit.
3. `Transform`: scale and translate vectors for world-space mapping.
4. `DatasetHandle`: id, uri, ome_version, multiscale metadata.
5. `CameraState2D`, `CameraStateArcball`, `CameraStateFreefly`.
6. `PointsLayer`: positions plus columnar attributes and LOD policy.
7. `CommandEnvelope`: id, method, params, timestamp.

## Architecture
1. `lucida-core` (Rust): ND state graph, transforms, scheduling, cache policy.
2. `lucida-render-wgpu` (Rust): WebGPU renderer for 2D, 3D, and points.
3. `lucida-daemon` (Rust): process lifecycle, windows/sessions, RPC server, event stream.
4. `lucida-py` (Python): typed client SDK and notebook integration.
5. `lucida-desktop` (packaging): signed installers for all 3 OS families.
6. `lucida-web-gateway` (phase 2): browser access by streaming frames/tiles and relaying input.

## Dependency policy
1. Core remains lean, stable, and framework-light.
2. Primary Rust dependencies: `wgpu`, `winit`, `zarrs`, `opendal`, `tokio`, `serde`, `tracing`.
3. Python SDK dependencies remain minimal and typed.
4. Optional capabilities are shipped as extras, not core requirements.
5. No Qt-based core dependency.

## OME-Zarr and data contract
1. Read support includes OME-Zarr v0.4 and v0.5.
2. Write/export targets OME-Zarr v0.5.
3. Storage backends: local filesystem, HTTP(S), and GCS-compatible object stores.
4. Credentials: standard cloud auth flows (env/config/instance roles), no custom auth plugin stack in v1.
5. Anisotropy is handled.
6. Axis handling uses canonical labels with adapter-level remapping from source order.

## Interaction and camera behavior
1. 2D mode uses pan/zoom controls optimized for microscopy navigation.
2. 3D arcball mode supports orbit-centric exploration.
3. 3D free-fly mode supports FPS-like navigation for volumetric inspection.
4. Axis sliders and controls support channel/time traversal and axis reordering.
5. Channel visibility/order and render properties are scriptable and UI-accessible.
6. All interactive changes emit command events for reproducibility.

## ND graph support
1. v1 graph scope is visualization-first for millions of points.
2. Core interactions include color-by-attribute, filtering, and box/lasso selection.
3. Linked selection hooks connect graph subsets with image layers.
4. GPU rendering includes LOD/downsampling safeguards for responsiveness.
5. Heavy analytics are expected in external scripts/notebooks and pushed into viewer state.

## Process model and notebook workflows
1. Lucida runs as a long-lived daemon hosting one or more sessions/windows.
2. Multiple clients can attach concurrently and issue commands.
3. Jupyter workflows use the Python SDK to mutate viewer state live.
4. Deterministic command logging enables replay, shareable workflows, and debugging.

## Web support
1. Browser clients connect through a remote gateway that streams rendered output and relays input/commands.
2. Default security posture is single-user trusted-network usage.
3. Localhost binding is default; remote bind is explicit opt-in with token/TLS.

## Performance and quality targets
1. Cold startup target is under 2 seconds on target hardware.
2. 2D interaction p95 target is under 50 ms after initial cache warmup.
3. Cached 2D navigation target is near 60 FPS.
4. 3D camera interaction target is at least 30 FPS on target hardware.
5. Idle memory target is under roughly 300 MB in baseline sessions.
6. UI thread must remain responsive during metadata and chunk IO activity.

## Testing and acceptance criteria
1. Unit tests cover axis remapping, transform math, camera state transitions, and command serialization/replay determinism.
2. Integration tests use real OME-Zarr fixtures over local, HTTP, and GCS paths (no mock middle-layer tests).
3. End-to-end tests validate daemon + SDK workflows from scripts/notebooks against observed state/events.
4. Rendering tests validate 2D, 3D, and points behavior with regression thresholds.
5. Performance tests enforce latency, FPS, and memory budgets in CI.
6. Release gating requires green checks on Windows, macOS, and Linux runners.

## Assumptions and defaults
1. v1 must include 2D + 3D + graph support, with graph features focused on visualization and interaction.
2. Extensibility in v1 is lightweight hooks, not a full plugin platform.
3. Observability is local logging plus optional crash/usage telemetry.
4. Distribution includes a pip SDK.
5. Security scope is single-user trusted network for remote mode in v1.
