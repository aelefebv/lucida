# Step 06 Sub-Spec: Points/Graph Layer and Linked Selection

## Objective
Implement deterministic points/graph-layer planning semantics for million-point workflows, including structured filtering, LOD behavior, and points-to-image linked selection hooks.

## What Lives in This Sub-Spec
1. Typed points-layer data contract behind existing methods.
2. Deterministic filter and LOD semantics for large point sets.
3. Canonical selection state (`query + resolved`) and event payload semantics.
4. Points planner/scheduler integration in Python runtime.
5. Points-pipeline primitives in Rust renderer scaffold.

## Scope
In scope:
1. Existing method behavior clarifications for Step 06:
   - `layer.add_points`
   - `layer.get`
   - `layer.update`
   - `selection.get`
   - `selection.set`
   - `selection.changed` event payload
2. Optional graph edge support via `edges_ref` attached to points layers.
3. Structured predicate filter AST validation and deterministic runtime handling.
4. Deterministic points planning with style/slice/camera/full invalidation coalescing.
5. Step 06 core/perf tests plus CI workflow.
6. Rust scaffold extensions for points pipeline primitive contracts.

Out of scope:
1. New RPC methods (for example `layer.add_graph`).
2. Bidirectional image-origin selection driving points selection.
3. In-app analytics/clustering/embedding features.
4. Daemon transport/session model work (owned by Step 07).

## Protocol and Interface Policy
1. Step 06 keeps the method list unchanged.
2. Step 06 introduces additive schema typing under protocol `1.0.0` pre-release policy.
3. Selection compatibility rule:
   - typed `PointsSelectionState` is canonical
   - legacy selection objects carrying `indices` remain accepted
4. Command-log schema version remains unchanged; event/request payloads remain schema-validated through existing refs.

## Points Data Contract
1. `layer.add_points.data_ref`:
   - shape must be `[N, D]`
   - `D >= 2`
   - dtype must be numeric
2. `point_id_ref` (optional):
   - shape `[N]`
   - integer dtype
3. `edges_ref` (optional):
   - shape `[E, 2]`
   - integer dtype
   - references point IDs when provided, otherwise row-index fallback semantics
4. `attribute_table_ref` (optional):
   - shape `[N, K]`
   - optional `attribute_columns` length must equal `K` when both are supplied
5. `coordinate_axes`:
   - required to match coordinate dimension `D` when supplied
   - defaults deterministically when omitted

## Filtering Semantics
1. Filter contract uses structured predicate AST (`PointsFilterPredicate`) only.
2. Supported ops:
   - `and`, `or`, `not`
   - `range`
   - `in`
   - `eq`
   - `exists`
3. Missing attribute behavior:
   - missing fields evaluate false
   - `exists` evaluates true only when attribute is present
4. Expression-string filters are out of scope for Step 06.

## LOD and Planning Semantics
1. Deterministic points pipeline:
   - frustum cull
   - predicate filter
   - screen-grid constrained reduction
2. Stable tie-break rule for deterministic down-selection:
   - smallest point ID wins when competition exists within a cell.
3. Default controls:
   - `lod_cell_px = 2`
   - `lod_max_points = 250000`
4. Points controls are patch-based on existing `layer.update.patch` keys:
   - `points_filter`
   - `color_by`
   - `color_map`
   - `lod_cell_px`
   - `lod_max_points`
   - `point_size`

## Selection and Linked Context Semantics
1. Canonical selection state includes:
   - `selection_version`
   - `query`
   - `resolved`
   - timestamps (`created_at` optional, `updated_at` required)
2. Inline selected ID cap is `4096`.
3. If selected IDs exceed cap, `selected_point_ids_ref` must be used.
4. `selection.changed` event payload includes:
   - `view_id`
   - optional `layer_id`
   - `selection_version`
   - `query`
   - `resolved_count`
   - inline `selected_point_ids` or `selected_point_ids_ref`
   - `linked_image_context`
5. Link direction in Step 06 is points-to-image hooks only:
   - runtime emits linked context
   - runtime does not auto-mutate image camera/slice state

## Invalidation and Coalescing
1. Invalidation kinds remain:
   - `full`
   - `slice`
   - `style`
   - `camera`
2. Points patch controls in Step 06 map to `style` invalidation.
3. Selection updates map to `style` invalidation for points planning.
4. Coalescing rule remains one plan update per view per dispatch cycle with priority:
   - `full > slice > style > camera`

## Deliverables
1. Step 06 protocol/docs updates:
   - `protocol/schemas/common/types.schema.json`
   - `protocol/schemas/requests/methods.request.schema.json`
   - `protocol/schemas/responses/methods.response.schema.json`
   - `protocol/schemas/events/events.schema.json`
   - `docs/protocol/README.md`
   - `python/lucida_sdk/protocol/generated/models.py`
2. Python runtime modules and integration:
   - `python/lucida_core/render_points/model.py`
   - `python/lucida_core/render_points/planner.py`
   - `python/lucida_core/render_points/scheduler.py`
   - `python/lucida_core/render_points/__init__.py`
   - `python/lucida_core/engine.py`
3. Rust scaffold extension:
   - `rust/crates/lucida-render-wgpu/src/lib.rs`
4. Step 06 tests and CI artifacts:
   - `tests/core/test_step6_points_graph.py`
   - `tests/perf/test_step6_points_perf.py`
   - `tests/perf/baselines/step6_points_perf.json`
   - `.github/workflows/step6-points.yml`

## Test and Acceptance Gates
1. Protocol conformance:
   - typed points/selection payloads validate
   - legacy selection payload compatibility remains valid
   - OpenRPC method list remains unchanged
2. Determinism:
   - identical command streams produce identical points plans, selection state, and events
3. Validation:
   - invalid points shape/dtype combinations are rejected
   - invalid edge descriptors are rejected
   - malformed predicate AST is rejected
4. Selection/linking:
   - selection event payload includes linked context
   - `session_seq` remains monotonic
   - inline/DataRef threshold behavior is deterministic and enforced
5. Rust scaffold:
   - workspace `cargo check` and `cargo test` continue to pass

## Performance Gates
1. PR smoke gate:
   - Step 06 perf test p95 planner/update dispatch <= `80ms` at `1M` points
2. Scheduled/nightly gate:
   - regression factor default `1.25` against checked-in Step 06 baseline

## Dependencies
1. Step 02 deterministic state model.
2. Step 04 invalidation/coalescing semantics.
3. Step 05 camera/render baseline and Rust scaffold workspace.

## Exit Criteria
Step 06 is complete when typed points/selection contracts are implemented behind existing methods, deterministic points planning/selection behavior is runtime-tested with perf gates, and points scaffold primitives are present in Rust without introducing new RPC methods.
