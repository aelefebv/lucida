# Step 04 Sub-Spec: 2D Renderer and Controls

## Objective
Implement deterministic 2D render planning and pan/zoom control semantics in the Python runtime so downstream renderer implementations can conform to a stable behavior contract.

## What Lives in This Sub-Spec
1. 2D display-plane selection semantics.
2. Canonical pan/zoom camera mapping and interaction math.
3. Multiscale level selection with hysteresis.
4. Render invalidation and coalescing policy.
5. Layer compositing plan semantics for 2D views.
6. Determinism and performance gate definitions.

## Scope
In scope:
1. Deterministic internal `FramePlan2D` generation for view-bound image layers.
2. Cursor-anchored zoom and zoom-scaled pan semantics.
3. Existing protocol method behavior clarifications for 2D planning:
   - `view.reorder_axes`
   - `view.set_axis_index`
   - `view.set_channel_order`
   - `camera.set_mode`
   - `camera.set_pose`
   - `camera.get`
   - `layer.update` (`visible`, `opacity`)
4. Two-tier performance gates (PR smoke + scheduled full regression checks).

Out of scope:
1. New RPC methods.
2. OpenRPC / JSON Schema field additions.
3. Rust/WGPU renderer implementation work.
4. 3D volume rendering semantics and camera behavior.

## Protocol and Interface Policy
1. Step 04 introduces no protocol schema or OpenRPC delta.
2. All behavior is implemented behind existing protocol contracts.
3. Public contract remains:
   - display axes chosen by `view.axis_order`
   - slice indices chosen by `view.axis_indices`
   - channel traversal chosen by `view.channel_order`

## 2D Plane Selection Semantics
1. Display plane is defined as the last two labels in `view.axis_order`.
2. All remaining axes are sliced using `view.axis_indices`.
3. Source-axis normalization remains at ingest via `dataset.open.axis_map`.
4. Users can choose effective X/Y display axes by reordering axes with `view.reorder_axes`.

## Pan/Zoom Semantics
### Canonical pose mapping in `panzoom` mode
1. `center_x = pose.target[0]`
2. `center_y = pose.target[1]`
3. `zoom = 1 / max(pose.position[2] - pose.target[2], 1e-6)`
4. Canonical `up` vector is `[0, 1, 0]`
5. `camera.get` in `panzoom` returns canonicalized pose representation.

### Cursor-anchored zoom
1. Wheel zoom keeps the cursor world-point stable.
2. Clamp zoom to `[1e-4, 1e4]`.
3. Invalid zoom factors (non-finite, non-positive) are rejected.

### Pan drag
1. Drag deltas are converted to world-space translation by dividing by zoom.
2. Content tracks drag direction, camera center moves in opposite world direction.

## Multiscale Level Selection Policy
1. Level selection uses screen-match target on displayed axes:
   - choose level minimizing `|log2(p)|`
   - where `p = zoom * downsample(level)`
2. `downsample(level)` is geometric mean of per-axis base-shape to level-shape ratio on display axes.
3. Hysteresis band prevents level flapping:
   - if current level has `p in [0.67, 1.5]`, keep current level.
4. If multiscale metadata is absent, fallback to level `0`.

## Invalidation and Coalescing
1. Invalidation kinds:
   - `full`
   - `slice`
   - `style`
   - `camera`
2. Trigger mapping:
   - `full`: `dataset.open`, `dataset.close`, `layer.add_image`, `layer.add_points`, `layer.remove`, `view.bind_layer`, `view.unbind_layer`, `view.reorder_axes`, `view.create`
   - `slice`: `view.set_axis_index`, `view.set_channel_order`
   - `style`: `layer.update.visible`, `layer.update.opacity`
   - `camera`: `camera.set_mode`, `camera.set_pose`
3. Coalescing rule:
   - within one dispatch cycle and target view, merge invalidation reasons and emit one new frame plan.
   - resulting kind uses strict priority: `full > slice > style > camera`.

## Compositing Plan Semantics
1. Layer order follows `view.bound_layer_ids`.
2. Layer visibility uses `layer.visible`.
3. Layer alpha uses `layer.opacity`.
4. Channel traversal uses `view.channel_order`.
5. Advanced blend modes and colormap semantics are out of scope for Step 04.

## Deliverables
1. `python/lucida_core/render2d/model.py`
2. `python/lucida_core/render2d/controls.py`
3. `python/lucida_core/render2d/planner.py`
4. `python/lucida_core/render2d/scheduler.py`
5. `python/lucida_core/engine.py` integration for invalidation + deterministic frame plans
6. Deterministic + perf test coverage and CI workflow for Step 04 gates

## Test and Acceptance Gates
1. Determinism:
   - same command stream yields identical frame-plan snapshots.
2. Axis/display flexibility:
   - `axis_map` + `view.reorder_axes` deterministically changes displayed plane.
3. Controls:
   - cursor-anchored zoom preserves anchor point.
   - pan delta scales by zoom.
4. Multiscale:
   - screen-match level selection chooses expected level.
   - hysteresis prevents flapping on small zoom perturbations.
5. Invalidation:
   - mapped commands emit expected invalidation kind.
   - coalescing merges multiple style reasons in one dispatch cycle.
6. Compositing:
   - plan reflects `visible`, `opacity`, `channel_order`, and bound-layer order.
7. Performance gates:
   - PR CI runs deterministic tests + perf smoke target.
   - scheduled/nightly runs full perf regression checks against checked-in baseline.

## Dependencies
1. Step 02 state model and command dispatch behavior.
2. Step 03 dataset metadata and multiscale summaries.

## Step 05 Handoff Note
Rust/WGPU scaffold is out of Step 04 scope and is owned by Step 05 kickoff.

## Exit Criteria
Step 04 is complete when deterministic 2D planning and control semantics are executable, tested, and trace-linked without protocol contract expansion.
