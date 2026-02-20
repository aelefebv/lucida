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
4. Protocol envelopes include `protocol_version`, and server/client must fail fast on incompatible versions.
5. Frame payload transport is a dedicated local frame socket using length-prefixed binary messages with JSON headers.
6. Slice 2A adds explicit render-mode control via `view.set_render_mode` and includes `render_mode` in `session.inspect` and `state.changed` payloads.
7. In `2d` render mode, frame payload semantics are camera-independent raw `u16` slice bytes for fixed `t/c/z`; pan/zoom are camera transforms, not daemon resampling.
8. Slice 2B hard-breaks `3d_stub`; the real 3D mode identifier is `3d`.
9. Slice 2B.1 3D semantics: `3d` frame payloads are raw MIP `u16` intensities (no daemon-side contrast windowing), with contrast applied once in app render state.

### Python SDK (`pip`)
1. `LucidaClient.connect(...)` and `LucidaClient.launch_or_connect(...)`.
2. `session.create(...)` and `session.close(...)`.
3. `session.inspect(...)` for session attach and app state introspection.
4. `dataset.open(uri, axis_map=..., read_only=True)` and `dataset.close(...)`.
5. `layer.add_image(...)`, `layer.add_points(...)`, `layer.update(...)`, `layer.remove(...)`.
6. `layer.set_sampling(...)`, `layer.set_contrast_limits(...)`, `layer.auto_contrast(...)`.
7. `view.set_axis(axis, index)`, `view.reorder_axes(order)`, `view.set_channel_order(order)`, `view.set_render_mode("2d"|"2d_stub"|"3d"|"graph_stub")`.
8. `camera.set_mode("panzoom"|"arcball"|"freefly")`, `camera.set_pose(...)`.
9. `events.subscribe(...)` for state/perf/errors/selections.
10. `frame_channel.open(...)` returns frame socket info and channel token for app render clients.
11. `command_log.export(...)`, `command_log.import(...)`, `command_log.replay(...)`.

### Command logging contract
1. `audit_log` stores all inbound RPC traffic and outcomes, including errors.
2. `replay_log` stores canonical state-mutating commands only, in deterministic replay order.
3. `command_log.export(...)` returns both logs and includes `log_schema_version`.
4. `command_log.replay(...)` must use the same reducer path as live execution.

### Canonical core types
1. `AxisLabel`: canonical labels (`t`, `c`, `z`, `y`, `x`, plus extra labels).
2. `AxisSpec`: label, size, unit.
3. `Transform`: scale and translate vectors for world-space mapping.
4. `DatasetHandle`: id, uri, ome_version, multiscale metadata.
5. `CameraState2D`, `CameraStateArcball`, `CameraStateFreefly`.
6. `PointsLayer`: positions plus columnar attributes and LOD policy.
7. `RenderMode`: `2d`, `2d_stub`, `3d`, `graph_stub`.
8. `SamplingMode`: `nearest`, `linear`.
9. `ImageRenderState`: `sampling_mode`, `contrast_limits`.
10. `CommandEnvelope`: id, method, params, timestamp.

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
1. 2D mode uses pan/zoom controls optimized for microscopy navigation, including mouse-wheel zoom and left-drag panning.
2. 2D zoom is cursor-anchored and camera-style (Napari-like), preserving the underlying `t/c/z` payload while changing view transform.
3. Sampling defaults to nearest-neighbor for microscopy pixel fidelity, with runtime switching available for comparison/debug (`nearest` vs `linear`).
4. Contrast limits are daemon-owned per image layer, default locked after auto-contrast, and replay-safe across app + Python clients.
5. 3D arcball mode supports orbit-centric exploration.
6. 3D free-fly mode supports FPS-like navigation for volumetric inspection.
7. Axis sliders and controls support channel/time traversal and axis reordering.
8. Channel visibility/order and render properties are scriptable and UI-accessible.
9. Render mode is explicit daemon-owned state, not app-local state.
10. All interactive changes emit command events for reproducibility.
11. Slice 2A+ controls include free-fly 6DoF navigation in `3d`: `W/A/S/D` forward-left-back-right, `E/Q` up-down, `I/J/K/L` pitch up/yaw left/pitch down/yaw right, `U/O` roll left-right.
12. Slice 2B.1 adds mouse-look in `3d` (left-drag yaw/pitch), wheel speed scaling in `3d`, and `R` reset to canonical freefly pose.
13. Entering `3d` performs one-shot shared bootstrap by default: canonical freefly pose and robust `(1,99)` contrast from the first 3D frame unless camera+contrast already appear user-tuned.
14. Slice 2B.2 adds app-local adaptive 3D frame quality tiers (`Interactive` while moving, `Settled` on idle) without changing daemon-owned replay state.

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
7. Slice 1 acceptance script: `/Users/austin/GitHub/lucida/python/examples/slice1_demo.py` must complete successfully.
8. Slice 2B acceptance script: `/Users/austin/GitHub/lucida/python/examples/slice2_real_3d_demo.py` must establish a session with `view.set_render_mode("3d")` against `/Users/austin/GitHub/lucida/fixtures/ome_zarr_v05_structured_3d`.
9. Slice 2B.1 acceptance: switching from 2D to `3d` with extreme prior 2D pan/zoom must still produce visible non-black structure without manual rescue contrast changes.
10. Slice 2B.2 acceptance: in release builds, active 3D navigation should sustain interactive responsiveness via adaptive quality and return to full-detail frames after brief idle.

## Assumptions and defaults
1. v1 must include 2D + 3D + graph support, with graph features focused on visualization and interaction.
2. Extensibility in v1 is lightweight hooks, not a full plugin platform.
3. Observability is local logging plus optional crash/usage telemetry.
4. Distribution includes a pip SDK.
5. Security scope is single-user trusted network for remote mode in v1.

## Incremental Delivery Plan
1. **Slice 0: Contract + Skeleton**
2. Deliverables: Rust workspace scaffold, protocol types, daemon process skeleton, IPC transport abstraction, Python package skeleton.
3. Acceptance: daemon starts, `health.ping` works from Python, protocol compatibility checks pass in CI matrix.
4. **Slice 1: Notebook-Driven 2D MVP**
5. Deliverables: local OME-Zarr v0.5 open, image layer add, 2D pan/zoom + axis stepping, full `audit_log`, deterministic `replay_log`.
6. Acceptance: scripted notebook flow reaches equivalent replay state hash.
7. **Slice 2: 3D + Graph Renderable Stubs**
8. Deliverables: arcball/freefly camera transitions, synthetic 3D path, synthetic points graph path, selection/perf events.
9. Acceptance: scripted mode transitions and selections replay safely.
10. **Slice 2A: Explicit Render Mode + Synthetic Frame Branching**
11. Deliverables: `view.set_render_mode`, `session.inspect.render_mode`, frame-service branching for `2d|2d_stub|3d_stub|graph_stub`, app hotkeys `1/2/3/4` mapped to render mode, and basic free-fly 6DoF controls in `3d_stub`.
12. Acceptance: app-visible mode switching is daemon-owned and replay-safe while existing 2D dataset path remains backward compatible.
13. **Slice 2B (current increment): Real `3d` Mode + Structured Volume Fixture**
14. Deliverables: hard break from `3d_stub` to `3d`, real dataset-backed 3D frame generation with deterministic CPU MIP, daemon volume cache keyed by `(session_id, dataset_uri, t, c)`, and committed fixture `/Users/austin/GitHub/lucida/fixtures/ome_zarr_v05_structured_3d`.
15. Acceptance: capabilities advertise `3d` only, `view.set_render_mode("3d_stub")` fails explicitly, and app hotkey `2` renders real volume-backed frames.
16. **Slice 2B.1 (current increment): 3D Visibility + Navigation Hardening**
17. Deliverables: mode-aware app transform (no 2D pan/zoom warp in `3d`/`graph_stub`), single-stage 3D contrast ownership in app, `3d` entry bootstrap, mouse-look controls, and mode-specific HUD/help text.
18. Acceptance: 3D is immediately visible at mode entry, contrast changes do not alter daemon 3D payload checksums, and camera movement still alters 3D payload checksums.
19. **Slice 2B.2 (current increment): 3D Performance Pass**
20. Deliverables: daemon 3D raymarch cost reductions (depth-based sample budget and incremental stepping), app adaptive 3D frame request resolution (`Interactive`/`Settled`), and frame timing HUD metrics (socket roundtrip/upload/present + daemon timings).
21. Acceptance: active 3D navigation uses interactive tier for smoother FPS and transitions back to settled full-resolution frames after idle with hysteresis guard.
22. **Slice 3: Data/Axis Hardening**
23. Deliverables: axis remapping validator, anisotropy transform checks, explicit 0.4 adapter seam.
24. Acceptance: fixtures validate canonical axis behavior and transform correctness.
25. **Slice 4: Remote Data Backends**
26. Deliverables: HTTP(S) and GCS-compatible adapters through shared storage abstraction.
27. Acceptance: integration opens real fixtures via local/HTTP/GCS-compatible endpoints.
28. **Slice 5: Performance + Reliability Gates**
29. Deliverables: startup timing probes, frame metrics, cache policy tuning, IO responsiveness safeguards.
30. Acceptance: CI enforces startup/latency/FPS/memory budgets.
31. **Slice 6: Packaging + Remote Gateway**
32. Deliverables: desktop packaging per OS and gateway prototype for frame stream + command relay.
33. Acceptance: signed/bundled smoke tests + trusted-network token flow.
