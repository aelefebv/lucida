# Step 01 Sub-Spec: Core Interfaces and Command Protocol

## Objective
Freeze a versioned, machine-readable control contract so daemon and SDK implementations can proceed without interface ambiguity.

## What Lives in This Sub-Spec
- Method taxonomy and naming (`domain.method`).
- Version negotiation and compatibility behavior.
- Request/response/event schema contracts.
- Idempotency, async-job, and error envelope rules.
- Command-log format and replay compatibility constraints.

## Scope
In scope:
1. OpenRPC registry.
2. JSON Schemas (common, requests, responses, events, errors, command-log).
3. Generated Python protocol models.
4. Protocol conformance tests.

Out of scope:
1. Rendering implementation.
2. OME-Zarr runtime IO behavior.
3. UI implementation.

## Interface and Contract Changes
- Freeze all v1 protocol methods listed in this sub-spec.
- Require `idempotency_key` on mutating calls.
- Require dedicated event stream with monotonic `session_seq` per session.

## Deliverables
1. `protocol/openrpc/lucida.v1.openrpc.json`
2. `protocol/schemas/**/*.schema.json`
3. `protocol/command-log/lucida.commandlog.v1.schema.json`
4. `python/lucida_sdk/protocol/generated/models.py`
5. `tests/protocol/*`

## Test and Acceptance Gates
1. OpenRPC references are complete and stable.
2. Schema validation tests pass.
3. Generated models are fresh (`--check` passes).
4. Golden method-list test passes.

## Dependencies
- None.

## Exit Criteria
Step 01 is complete when protocol consumers can implement daemon and SDK behavior without making new interface decisions.

## Canonical Artifacts (Frozen)

1. OpenRPC registry:
   - `protocol/openrpc/lucida.v1.openrpc.json`
2. Request schemas:
   - `protocol/schemas/requests/methods.request.schema.json`
3. Response schemas:
   - `protocol/schemas/responses/methods.response.schema.json`
4. Event schemas:
   - `protocol/schemas/events/events.schema.json`
5. Error envelope:
   - `protocol/schemas/errors/error.schema.json`
6. Primitive/composite shared types:
   - `protocol/schemas/common/primitives.schema.json`
   - `protocol/schemas/common/types.schema.json`
7. Command log line schema:
   - `protocol/command-log/lucida.commandlog.v1.schema.json`

## Frozen Method Set

1. `system.hello`
2. `system.capabilities.get`
3. `session.create`
4. `session.close`
5. `session.get`
6. `dataset.open`
7. `dataset.close`
8. `dataset.get`
9. `layer.add_image`
10. `layer.add_points`
11. `layer.update`
12. `layer.remove`
13. `layer.get`
14. `view.set_axis_index`
15. `view.reorder_axes`
16. `view.set_channel_order`
17. `camera.set_mode`
18. `camera.set_pose`
19. `camera.get`
20. `selection.get`
21. `selection.set`
22. `job.get`
23. `job.cancel`
24. `job.list`
25. `events.subscribe`
26. `command_log.export`
27. `command_log.import`
28. `command_log.replay`

## Protocol Behavior Guarantees

1. Handshake and compatibility:
   - `system.hello` is the first command on a connection.
   - client sends min/max supported version range.
   - daemon returns selected version or typed incompatibility error.
   - no silent fallback.
2. Async jobs:
   - long-running commands return `job_id` and `accepted_at` immediately.
   - lifecycle states: `queued`, `running`, `completed`, `failed`, `cancelled`.
3. Ordered events:
   - dedicated event stream with monotonic `session_seq` per session.
4. Idempotency:
   - mutating methods require `idempotency_key`.
5. Large payload policy:
   - out-of-band `DataRef` for large arrays.
   - inline JSON control payload limit is 65,536 bytes.
6. Command logs:
   - JSONL, one schema-validated record per line.
   - replay requires version compatibility validation.

## Protocol Freeze Rules

1. Any change that affects required fields, method signatures, ordering semantics, or retry semantics is a breaking change.
2. Breaking changes require a major protocol version bump and a new OpenRPC/schema set.
3. Additive changes may only be introduced as minor versions and must preserve existing method behavior.
4. Generated SDK protocol models must always be reproducible from schema artifacts.

## Context and Traceability Touchpoints

When Step 01 artifacts change, update these context files in the same change set:

1. `docs/context/traceability.yaml` (step-01 implementation/test/protocol artifact mapping and `last_validated`).
2. `docs/context/status.md` (if step status changes).
3. `docs/context/index.yaml` (if context artifact inventory changes).
4. `docs/protocol/README.md` (if human-readable behavior contract changes).
