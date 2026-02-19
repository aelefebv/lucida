# Step 05 Sub-Spec: 3D Renderer and Cameras

## Objective
Implement 3D rendering with both arcball and free-fly camera modes while preserving predictable scripting semantics.

## What Lives in This Sub-Spec
- 3D volume rendering pipeline.
- Arcball and free-fly camera behavior contracts.
- Camera pose serialization and restoration.
- 3D interaction tuning and update scheduling.

## Scope
In scope:
1. 3D camera mode switching (`arcball`, `freefly`).
2. Pose updates via protocol commands.
3. Basic render controls and quality presets.

Out of scope:
1. Advanced cinematic effects.
2. Full scene-editing toolchain.

## Interface and Contract Changes
- Define full `camera.get` response fidelity for 3D modes.
- Ensure `camera.set_pose` and `camera.set_mode` are deterministic and replay-safe.

## Deliverables
1. 3D renderer module.
2. Arcball/free-fly controller implementations.
3. Camera state serialization tests.
4. 3D performance tests.

## Test and Acceptance Gates
1. 3D camera interaction reaches >=30 FPS on target hardware.
2. Replayed camera commands reproduce equivalent view state.
3. Mode switches do not corrupt camera state.

## Dependencies
- Step 02, Step 03.
- Step 04 render orchestration patterns.

## Exit Criteria
Step 05 is complete when 3D navigation and rendering are stable, scriptable, and performant.
