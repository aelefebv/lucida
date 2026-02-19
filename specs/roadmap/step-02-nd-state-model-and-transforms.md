# Step 02 Sub-Spec: ND State Model and Transforms

## Objective
Implement the executable in-memory ND state engine for protocol v1 with deterministic transitions, explicit multi-view state, multi-dataset workflows, anisotropic transform handling, and typed error behavior.

## What Lives in This Sub-Spec
- Session, dataset, layer, view, camera, selection, job, and subscription state entities.
- Deterministic command dispatcher for all protocol methods.
- Idempotency policy and response caching for mutating methods.
- Synthetic dataset adapter for Step 2-only dataset behavior.
- In-memory ordered event outbox with monotonic `session_seq`.
- Layer-to-view compatibility checks for overlays and side-by-side workflows.

## Scope
In scope:
1. Python runtime package at `python/lucida_core`.
2. Deterministic in-memory state transitions for all methods in protocol v1.
3. Async job simulation (`queued -> running -> completed`) for dataset/layer operations.
4. Multi-dataset support per session and explicit view lifecycle.
5. Strict view-layer compatibility checks.
6. Protocol docs/schema updates and contract tests required by v1.

Out of scope:
1. Real OME-Zarr backend I/O.
2. Real daemon transport/session orchestration.
3. Command log export/import/replay execution semantics.
4. Renderer implementation.

## Protocol Delta Owned by Step 2
Step 2 introduces and owns the protocol v1 delta from the Step 1 baseline:

1. Add methods:
   - `view.create`
   - `view.close`
   - `view.get`
   - `view.bind_layer`
   - `view.unbind_layer`
2. Require `view_id` for:
   - `view.set_axis_index`
   - `view.reorder_axes`
   - `view.set_channel_order`
   - `camera.set_mode`
   - `camera.set_pose`
   - `camera.get`
   - `selection.get`
   - `selection.set`
3. Keep `dataset_id` layer binding semantics unchanged (`layer.add_image` remains dataset-scoped).
4. Keep `events.subscribe`, but Step 2 returns deterministic in-memory handles.
5. Keep `command_log.export`, `command_log.import`, and `command_log.replay` mapped but explicitly unsupported in Step 2.

## State Entities and Invariants

### Session State
1. Session IDs are UUIDv7.
2. Session lifecycle states: `active`, `closing`, `closed`.
3. Session owns:
   - datasets
   - layers
   - views
   - jobs
   - subscriptions
   - ordered event outbox
4. `session_seq` is monotonic per session.

### Dataset State
1. Multiple datasets may coexist in one session.
2. Step 2 supports synthetic URIs only (`synthetic://...`, `mem://...`).
3. Non-synthetic URIs fail with `LUCIDA_UNSUPPORTED_CAPABILITY`.

### Layer State
1. Image layers are dataset-bound.
2. Points layers are accepted with `DataRef` and optional metadata.
3. Layer visibility/opacity updates are deterministic and replay-safe.

### View State
1. Views are explicit first-class entities (UUIDv7).
2. A view contains:
   - axis order
   - axis indices
   - channel order
   - bound layer IDs
   - camera mode/pose
   - selection payload
3. Side-by-side behavior is modeled via multiple views, not layout geometry commands.

### Compatibility Invariant
1. Binding a layer to a view is rejected if the layer dataset is incompatible with already bound dataset-backed layers.
2. Compatibility requires matching canonical axis labels, shape, and world transform.

## Deterministic Transition Rules
1. Dispatch is pure relative to state + command + deterministic clock/UUID providers.
2. Method-level side effects are deterministic in order and payload.
3. Idempotent mutating calls return cached prior responses and do not reapply side effects.
4. Error precedence for each dispatch:
   - version mismatch
   - invalid params
   - not found
   - conflict/incompatible state
   - unsupported capability
   - internal fallback

## Idempotency Rules
1. Mutating methods require `idempotency_key`.
2. Cache key: `(session_id_or_system_scope, method, idempotency_key)`.
3. Cache stores successful response payload for replay-safe retries.
4. Command failures are not cached.

## Job Simulation Rules (Step 2)
1. For dataset/layer long-running operations, Step 2 simulates:
   - `queued`
   - `running`
   - `completed`
2. Lifecycle transitions emit ordered job events.
3. `job.get` and `job.list` expose deterministic job snapshots.
4. `job.cancel` is supported only for non-terminal jobs; otherwise `LUCIDA_CONFLICT`.

## Event Outbox Rules
1. All events emitted by Step 2 are retained in-session in an in-memory outbox.
2. Event envelope fields are always populated:
   - `session_id`
   - `event_id`
   - `event_type`
   - `session_seq`
   - `emitted_at`
3. `events.subscribe` returns deterministic `memory://<session>/<subscription>` URI handles.

## Method-to-Behavior Matrix

### Fully Functional in Step 2
1. `system.*`
2. `session.*`
3. `dataset.*` (synthetic URI policy)
4. `layer.*`
5. `view.*` (including lifecycle and layer binding)
6. `camera.*`
7. `selection.*`
8. `job.*`
9. `events.subscribe`

### Explicitly Unsupported in Step 2
1. `command_log.export`
2. `command_log.import`
3. `command_log.replay`

All three return `LUCIDA_UNSUPPORTED_CAPABILITY` with deterministic details pointing to Step 09 ownership.

## Deliverables
1. `python/lucida_core/` runtime package.
2. Updated protocol contracts and OpenRPC for v1 explicit-view model.
3. Updated protocol docs and top-level spec references.
4. Runtime tests for determinism/idempotency/multi-view workflows.

## Test and Acceptance Gates
1. Deterministic replay of the same command stream yields identical state and event snapshots.
2. Idempotency cache prevents duplicate side effects for repeated mutating requests.
3. Multi-dataset overlay flow succeeds for compatible datasets.
4. Side-by-side multi-view flow is isolated and deterministic.
5. Incompatible view binding fails with typed conflict error.
6. Non-synthetic dataset URI fails with typed unsupported error.
7. Async job simulation emits ordered lifecycle events.
8. `events.subscribe` returns deterministic in-memory transport handles.
9. Command-log methods return typed unsupported errors.
10. Protocol and context checks remain green.

## Dependencies
- Step 01 baseline protocol contracts and policy tests.

## Exit Criteria
Step 02 is complete when protocol v1 explicit-view semantics and deterministic in-memory runtime behavior are implemented, tested, and trace-linked for downstream Step 03/04/05/07/09 integration.
