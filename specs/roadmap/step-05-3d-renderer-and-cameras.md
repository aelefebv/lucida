# Step 05 Sub-Spec: 3D Renderer and Cameras

## Objective
Implement deterministic 3D render planning semantics in the Python reference runtime while kicking off the Rust renderer scaffold that will own long-term runtime rendering.

## What Lives in This Sub-Spec
1. 3D volume-axis resolution and slicing semantics.
2. Deterministic arcball/freefly camera canonicalization for replay-safe behavior.
3. Standardized 3D layer render controls (`mip`, `alpha`, `iso`) through existing `layer.update.patch`.
4. 3D multiscale screen-match and hysteresis level-selection policy.
5. 3D invalidation/coalescing semantics aligned with Step 04.
6. Step 05 Rust workspace and renderer-shell scaffold kickoff deliverables.

## Scope
In scope:
1. Deterministic internal `FramePlan3D` generation for view-bound image layers.
2. Full 6DOF camera behavior contract for both `arcball` and `freefly` modes.
3. Existing protocol method behavior clarifications for Step 05 semantics:
   - `camera.set_mode`
   - `camera.set_pose`
   - `camera.get`
   - `view.reorder_axes`
   - `view.set_axis_index`
   - `view.set_channel_order`
   - `layer.update` render-control patch keys.
4. Rust renderer scaffold/workspace creation and compile/test baseline.
5. Two-tier Step 05 performance gates (PR smoke + scheduled full regression checks).

Out of scope:
1. Protocol/OpenRPC/schema expansion.
2. Production Python-to-Rust render-path bridging in Step 05.
3. Advanced cinematic/post-processing effects.
4. Full scene editing toolchain.

## Protocol and Interface Policy
1. Step 05 introduces no RPC methods and no schema/OpenRPC deltas.
2. All behavior is implemented behind existing protocol contracts.
3. Public contract remains:
   - axis remapping at ingest (`dataset.open.axis_map`)
   - view axis/order/slice controls (`view.reorder_axes`, `view.set_axis_index`)
   - channel traversal (`view.set_channel_order`)
   - camera mode/pose controls (`camera.set_mode`, `camera.set_pose`, `camera.get`)
   - layer style updates (`layer.update.patch`)

## 3D Volume-Axis and Slice Semantics
1. 3D volume axes are the last three labels in `view.axis_order`.
2. All non-volume axes are sliced through `view.axis_indices`.
3. If three volume axes cannot be resolved for a view, the 3D planner emits a non-renderable plan with reason `insufficient_volume_axes` while protocol responses remain unchanged.

## Camera Semantics
### Canonicalization (`camera.set_pose` / `camera.get`)
1. `camera.get` returns finite canonicalized vectors for `position`, `target`, and normalized `up`.
2. `fov_degrees` is passed through if present and finite.

### `arcball` mode
1. Camera orbits around `target`.
2. Radius is `||position - target||`, clamped to `>= 1e-6`.
3. Roll is allowed; no world-up lock is applied.

### `freefly` mode
1. Camera uses local-basis movement/orientation semantics.
2. Yaw/pitch/roll are all valid (full 6DOF).
3. No world-up constraint is applied.

## Step 05 3D Render Controls via `layer.update.patch`
Standardized keys (behavioral contract, no schema change):
1. `render_mode`: `mip|alpha|iso` (default `mip`)
2. `iso_threshold`: range `[0, 1]` (default `0.5`, used by `iso`)
3. `density_scale`: `> 0` (default `1.0`, used by `alpha`)
4. `sample_step`: `> 0` voxel units (default `1.0`, used by all modes)

Validation policy:
1. Invalid values are rejected deterministically with typed invalid-params behavior.
2. Step 05 render-control keys apply only to image layers.

## Multiscale Level Selection (3D)
1. Level selection uses screen-match target on the three volume axes:
   - choose level minimizing `|log2(p)|`
   - where `p = zoom * downsample(level)`
2. `downsample(level)` is geometric mean of base-to-level shape ratios on the resolved volume axes.
3. Hysteresis band prevents flapping:
   - if current level has `p in [0.67, 1.5]`, keep current level.
4. If multiscale metadata is absent, fallback to level `0`.

## Invalidation and Coalescing
1. Invalidation kinds remain:
   - `full`
   - `slice`
   - `style`
   - `camera`
2. Step 05 render-control patch updates (`render_mode`, `iso_threshold`, `density_scale`, `sample_step`) map to `style` invalidation.
3. Coalescing rule remains one plan update per view per dispatch cycle.
4. Priority remains `full > slice > style > camera`.

## Compositing Plan Semantics (3D)
1. Layer order follows `view.bound_layer_ids`.
2. Layer visibility uses `layer.visible`.
3. Layer alpha uses `layer.opacity`.
4. Channel traversal uses `view.channel_order`.
5. Per-layer Step 05 render controls are resolved into deterministic plan entries.

## Deliverables
1. Python deterministic 3D planning modules:
   - `python/lucida_core/render3d/model.py`
   - `python/lucida_core/render3d/controls.py`
   - `python/lucida_core/render3d/planner.py`
   - `python/lucida_core/render3d/scheduler.py`
2. `python/lucida_core/engine.py` integration for 3D invalidation + deterministic `FramePlan3D` generation.
3. Step 05 core/perf tests and Step 05 CI workflow.
4. Rust scaffold/workspace kickoff artifacts (see next section).

## Step 05 Kickoff Rust Scope
Step 05 kickoff owns renderer bootstrap work excluded from Step 04:

1. Create Rust renderer scaffold and workspace targets for Lucida render runtime components.
2. Establish compile/test baseline for renderer crate(s) with stable CI entrypoints.
3. Build initial `lucida-render-wgpu` scaffold crate with Step 05 render-control primitives.
4. Build minimal `lucida-render-shell` harness crate to anchor renderer startup wiring.
5. Preserve Step 04 deterministic 2D semantics as baseline behavior while Rust runtime scaffolding is introduced.

## Test and Acceptance Gates
1. Determinism:
   - same command stream yields identical `FramePlan3D` snapshots.
2. Axis/display flexibility:
   - `axis_map` + `view.reorder_axes` deterministically changes resolved 3D volume axes.
3. Camera behavior:
   - deterministic canonicalization for `arcball` and `freefly`.
   - roll survives replay and mode transitions (full 6DOF contract).
4. Controls:
   - arcball preserves pivot/radius semantics.
   - freefly movement follows local basis after roll.
5. Render modes:
   - `mip|alpha|iso` resolve from patch keys with deterministic defaults.
   - invalid render-control values are rejected.
6. Multiscale:
   - 3-axis screen-match selection chooses expected level.
   - hysteresis prevents level flapping near thresholds.
7. Invalidation/coalescing:
   - Step 05 style keys map to style invalidation.
   - burst updates coalesce to one plan-update cycle per view.
8. Rust scaffold:
   - workspace `cargo check` and `cargo test` pass in CI.

## Performance Gates
1. PR CI:
   - deterministic Step 05 tests
   - Step 05 perf smoke gate
   - Rust workspace `cargo check` + `cargo test`
2. Scheduled/nightly:
   - full perf regression gate with baseline and default factor `1.25`
   - optional GPU-backed render-loop benchmark track for 30 FPS target

## Dependencies
1. Step 02 state model and deterministic command dispatch behavior.
2. Step 03 dataset metadata and multiscale summaries.
3. Step 04 deterministic invalidation/coalescing and 2D planning baseline.

## Exit Criteria
Step 05 is complete when deterministic 3D semantics are executable and test-gated in Python reference runtime, Rust renderer scaffold kickoff artifacts are in place with compile/test baselines, and protocol boundaries remain unchanged.
