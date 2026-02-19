# Step 04 Sub-Spec: 2D Renderer and Controls

## Objective
Ship a high-performance 2D rendering path with intuitive pan/zoom interactions and protocol-driven updates.

## What Lives in This Sub-Spec
- 2D image render pipeline contract.
- Pan/zoom camera behavior and input mapping.
- Layer compositing semantics (visibility, opacity, channel selection).
- Frame update scheduling tied to state changes.

## Scope
In scope:
1. 2D rendering with multiscale level selection.
2. Input handling for pan/zoom and viewport updates.
3. Synchronization with view/camera protocol commands.

Out of scope:
1. 3D volume rendering.
2. Points/graph rendering.

## Interface and Contract Changes
- Ensure `camera.set_mode` supports 2D pan/zoom semantics.
- Ensure `view.set_axis_index` and channel updates trigger correct redraws.

## Deliverables
1. 2D renderer module.
2. Input-to-camera mapping for 2D mode.
3. Render invalidation/update pipeline.
4. 2D performance and regression tests.

## Test and Acceptance Gates
1. Cached pan/zoom is near 60 FPS on target hardware.
2. P95 interaction latency target (<50 ms) is met in baseline fixtures.
3. Rendering reflects layer/view state deterministically.

## Dependencies
- Step 02 state model.
- Step 03 IO/cache for data access.

## Exit Criteria
Step 04 is complete when 2D workflows are responsive, deterministic, and protocol-consistent.
