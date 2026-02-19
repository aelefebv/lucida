# Lucida SPEC

## 1. Overview

Lucida is a lightweight, high-performance, cross-platform n-dimensional image viewer for microscopy datasets.

It targets Napari-like workflows with stricter priorities:
- lower overhead
- higher responsiveness
- fewer bugs
- minimal dependencies
- full scriptability

Lucida must run on:
- Windows
- macOS
- Linux

Primary dataset format:
- OME-Zarr (read-heavy focus for very large datasets, including terabyte-scale archives)

## 2. Product Goals

1. Provide fluid interactive visualization for ND microscopy data (2D + 3D + channel/time navigation).
2. Make every viewer action programmable through a stable API.
3. Support "viewer as separate process" workflows (notebooks/scripts controlling a live window).
4. Handle anisotropic voxel spacing correctly in rendering and navigation.
5. Support ND point/graph visualization (millions of points) with interactive filtering and selection.
6. Keep core runtime lean with optional extras for non-core capabilities.

## 3. Non-Goals (v1)

1. Multi-tenant production-grade server isolation/authz.
2. Full plugin marketplace/framework parity with Napari.
3. Heavy in-app analytics pipelines (clustering/embedding/etc.) as core features.
4. Full browser parity with desktop in v1.

## 4. Scope (v1)

### In Scope

1. 2D image viewing with pan/zoom camera.
2. 3D volume viewing with:
   - arcball camera
   - free-fly camera
3. ND axis controls:
   - canonical axis model
   - channel/time traversal
   - axis reordering
   - channel reordering/visibility
4. OME-Zarr IO:
   - read v0.4 and v0.5
   - write/export v0.5
5. Storage backends:
   - local filesystem
   - HTTP(S)
   - S3-compatible object stores
6. Long-lived daemon process + session model.
7. Typed Python SDK for scripting and Jupyter workflows.
8. Command log capture and deterministic replay.
9. ND graph/point visualization:
   - millions of points
   - GPU rendering + LOD
   - filtering/coloring/selection
   - linked selection hooks to image views
10. Desktop installers + pip SDK distribution.
11. Local logs + optional crash and usage telemetry.

### Out of Scope (v1)

1. Full plugin framework lifecycle/discovery.
2. Multi-user tenancy model.
3. Browser-native rendering parity.

## 5. Core Architecture

### 5.1 Language/Component Split

- Rust core for performance-critical runtime:
  - state model
  - IO/caching/scheduling
  - rendering pipeline
  - process daemon
- Python SDK for scripting ergonomics and notebook integration.

### 5.2 Main Components

1. `lucida-core` (Rust)
   - canonical ND state graph
   - axis semantics
   - transform math
   - command processing
2. `lucida-render-wgpu` (Rust)
   - WebGPU primary renderer
   - 2D/3D/points pipelines
   - fallback path for unsupported hardware (limited feature mode)
3. `lucida-daemon` (Rust)
   - long-lived process
   - session/window lifecycle
   - RPC server + event streaming
4. `lucida-py` (Python)
   - typed API client
   - notebook workflows
   - replay and automation helpers
5. `lucida-desktop` (packaging)
   - signed installers for Windows/macOS/Linux
6. `lucida-web-gateway` (Phase 2)
   - remote browser client support via streamed render output + input relay

## 6. Data and Axis Model

### 6.1 Canonical Axis Semantics

- Core axis labels use canonical names (`t`, `c`, `z`, `y`, `x`, plus additional named dims).
- Source datasets can have arbitrary order; adapters map source order to canonical model.
- Internal API remains canonical and stable.

### 6.2 Anisotropy

- Physical scaling is represented in world-space transforms.
- Rendering and camera controls must respect anisotropic spacing.

### 6.3 OME-Zarr Contract

- Read compatibility: OME-Zarr 0.4 and 0.5.
- Write compatibility: OME-Zarr 0.5.
- Multiscale metadata must be preserved and surfaced through API.

## 7. API and Process Contract

### 7.1 Control Protocol

- JSON-RPC 2.0.
- Default local transport:
  - Unix sockets (macOS/Linux)
  - named pipes (Windows)
- Optional remote transport:
  - TCP/WebSocket with token auth and TLS guidance

### 7.2 Python SDK (public surface)

- `launch_or_connect(...)`
- `connect(...)`
- `create_session(...)`
- `open_dataset(...)`
- `add_image_layer(...)`
- `add_points_layer(...)`
- `set_axis_index(...)`
- `reorder_axes(...)`
- `set_channel_order(...)`
- `set_camera_mode(...)`
- `set_camera_pose(...)`
- `subscribe_events(...)`
- `export_command_log(...)`
- `import_command_log(...)`
- `replay_command_log(...)`

All user-visible actions must map to command API operations.

### 7.3 Command Log

- Deterministic action stream for reproducibility.
- Persist/export/import/replay supported in v1.
- Full undo/redo stack is not required in v1.

## 8. Interaction Model

### 8.1 2D Camera

- Pan/zoom optimized for microscopy inspection.
- Smooth wheel and drag behavior, low-latency updates.

### 8.2 3D Cameras

- Arcball for object-centric exploration.
- Free-fly for scene-centric navigation (FPS-like control).

### 8.3 ND Controls

- Channel/time stepping.
- Axis slider and reorder controls.
- Visibility toggles and render property changes per channel/layer.

## 9. ND Graph/Points Visualization

v1 is visualization-first (not analytics-first):
- render millions of points interactively
- color by attribute
- filter by attribute ranges/categories
- box/lasso selection
- linked selection callbacks to image context
- GPU LOD/downsampling strategy to maintain responsiveness

## 10. Security and Remote Operation

### 10.1 v1 Security Posture

- Single-user trusted-network model.
- Localhost bind by default.
- Remote bind is explicit opt-in.
- Token-based access for remote control endpoints.
- TLS strongly recommended for non-localhost deployment.

### 10.2 Credentials

- Standard cloud credential mechanisms for S3 and signed HTTP.
- No custom auth plugin framework in v1.

## 11. Performance and Resource Targets (v1)

1. Cold startup: under 2 seconds on target hardware.
2. 2D interactive latency (p95): under 50 ms after cache warmup.
3. 2D cached navigation: near 60 FPS.
4. 3D camera interaction: at least 30 FPS on target hardware.
5. Idle memory footprint: around or under 300 MB in baseline session.
6. UI thread remains responsive during background IO.

Target hardware baseline:
- modern GPUs (roughly 2020+ integrated/discrete, Apple M-series included)

## 12. Dependency Policy

1. Lean core dependency surface.
2. Optional advanced features as extras.
3. Prefer maintained, widely adopted libraries.
4. Avoid heavyweight GUI stack lock-in for core rendering path.

## 13. Testing Strategy

No mock-heavy middle-layer tests. Prioritize unit and e2e/integration on real paths.

### 13.1 Unit Tests

- axis remapping correctness
- transform math (including anisotropy)
- camera state transitions
- command serialization/replay determinism

### 13.2 Integration Tests

- real OME-Zarr fixtures over:
  - local filesystem
  - HTTP(S)
  - S3-compatible storage

### 13.3 End-to-End Tests

- daemon + Python SDK workflows
- live session mutation from scripts/notebooks
- event stream correctness
- layer/camera/axis state coherence

### 13.4 Performance Tests

- latency/FPS/memory budgets enforced in CI

### 13.5 Platform Coverage

- CI must pass on Windows, macOS, Linux

## 14. Distribution

v1 deliverables:
1. Cross-platform desktop installers.
2. Pip-installable Python SDK for scripting and notebook control.

## 15. Roadmap (high-level)

1. Define core interfaces and command protocol.
2. Implement ND state model and transform system.
3. Implement OME-Zarr IO + cache scheduler.
4. Implement 2D renderer and controls.
5. Implement 3D renderer + arcball/free-fly cameras.
6. Implement points/graph layer with linked selection.
7. Implement daemon session model + event stream.
8. Implement Python SDK + notebook integration.
9. Implement command log replay.
10. Implement installers + CI/release gates.
11. Phase 2: remote web gateway.

## 16. Roadmap Sub-Spec Table of Contents

Each roadmap step has a dedicated sub-spec in `specs/roadmap/`. These files are implementation-facing and should hold step-specific scope, interfaces, dependencies, acceptance criteria, and test gates.

Operational note:

1. `AGENTS.md` is the first playbook for planning and implementation sessions.
2. `docs/context/traceability.yaml` and `docs/context/status.md` are the canonical implementation progress references.

1. [`specs/roadmap/step-01-core-interfaces-and-command-protocol.md`](specs/roadmap/step-01-core-interfaces-and-command-protocol.md)
   - Source of truth for command protocol contracts, versioning rules, and schema/OpenRPC artifacts.
2. [`specs/roadmap/step-02-nd-state-model-and-transforms.md`](specs/roadmap/step-02-nd-state-model-and-transforms.md)
   - ND state graph, axis semantics, anisotropic world transforms, and deterministic state transitions.
3. [`specs/roadmap/step-03-ome-zarr-io-and-cache-scheduler.md`](specs/roadmap/step-03-ome-zarr-io-and-cache-scheduler.md)
   - OME-Zarr adapters, remote/local backend behavior, chunk scheduling, and cache policy.
4. [`specs/roadmap/step-04-2d-renderer-and-controls.md`](specs/roadmap/step-04-2d-renderer-and-controls.md)
   - 2D render pipeline contract, pan/zoom controls, and interaction latency targets.
5. [`specs/roadmap/step-05-3d-renderer-and-cameras.md`](specs/roadmap/step-05-3d-renderer-and-cameras.md)
   - 3D render modes and camera semantics for arcball and free-fly workflows.
6. [`specs/roadmap/step-06-points-graph-layer-and-linked-selection.md`](specs/roadmap/step-06-points-graph-layer-and-linked-selection.md)
   - Million-point rendering, LOD behavior, selection contracts, and linked-view interactions.
7. [`specs/roadmap/step-07-daemon-session-model-and-event-stream.md`](specs/roadmap/step-07-daemon-session-model-and-event-stream.md)
   - Daemon lifecycle, multi-session behavior, and event delivery guarantees.
8. [`specs/roadmap/step-08-python-sdk-and-notebook-integration.md`](specs/roadmap/step-08-python-sdk-and-notebook-integration.md)
   - SDK surface, generated typing behavior, notebook control workflows, and client ergonomics.
9. [`specs/roadmap/step-09-command-log-replay.md`](specs/roadmap/step-09-command-log-replay.md)
   - Export/import/replay semantics, determinism constraints, and replay safety checks.
10. [`specs/roadmap/step-10-installers-and-ci-release-gates.md`](specs/roadmap/step-10-installers-and-ci-release-gates.md)
   - Packaging matrix, signing/distribution requirements, and CI release criteria.
11. [`specs/roadmap/step-11-remote-web-gateway-phase-2.md`](specs/roadmap/step-11-remote-web-gateway-phase-2.md)
   - Phase 2 browser gateway architecture, transport rules, and security posture.

## 17. Step 1 Protocol Baseline (Frozen)

The detailed Step 1 protocol baseline is now maintained only in:

- [`specs/roadmap/step-01-core-interfaces-and-command-protocol.md`](specs/roadmap/step-01-core-interfaces-and-command-protocol.md)

This top-level spec intentionally avoids duplicating Step 1 protocol details so there is a single source of truth.

## 18. Explicit Assumptions and Defaults

1. Rust core + Python SDK is the default architecture.
2. WebGPU is primary rendering backend with constrained fallback path.
3. v1 includes 2D + 3D + graph support.
4. v1 supports local/HTTP/S3 OME-Zarr access.
5. Browser support is phase 2 (remote gateway), not day-one parity.
6. Extensibility in v1 is lightweight hooks, not full plugin framework.
7. Observability includes local logs and optional crash/usage telemetry.

## 19. Context System and Governance

Lucida uses a guidance-first context system to keep future coding agents and developers aligned with spec intent while minimizing process overhead.

Core artifacts:

1. `AGENTS.md`: operational planning/implementation workflow.
2. `docs/context/index.yaml`: machine-readable context artifact catalog.
3. `docs/context/traceability.yaml`: step-level spec-to-implementation mapping and status.
4. `docs/context/status.md`: human-readable roadmap status summary.
5. `CONTRIBUTING.md`: required validation and handoff expectations.

Automation:

1. `scripts/check_context.py` validates context contracts.
2. `tests/context/test_context_contracts.py` verifies checker behavior and required templates/playbook content.
3. `.github/workflows/context-check.yml` runs context checks on PRs and pushes.
