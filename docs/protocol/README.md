# Lucida Protocol v1

This document is the human-readable guide for the machine-readable contract in:

- `protocol/openrpc/lucida.v1.openrpc.json`
- `protocol/schemas/**/*.schema.json`
- `protocol/command-log/lucida.commandlog.v1.schema.json`

## 1. Contract source of truth

1. JSON-RPC 2.0 is the command protocol.
2. OpenRPC and JSON Schema are canonical.
3. If this document and schema artifacts disagree, schema artifacts win.

## 2. Transport model

1. Command channel:
   - Request/response RPC channel over local IPC by default.
   - Optional remote channel over TCP/WebSocket.
2. Event channel:
   - Dedicated stream, separate from request/response channel.
   - Events are ordered per session with monotonic `session_seq`.

## 3. Handshake and compatibility

1. The first command on a new connection is `system.hello`.
2. Client sends:
   - `supported_versions.min_version`
   - `supported_versions.max_version`
   - client identity (`client_name`, `client_version`)
3. Daemon returns:
   - selected protocol version
   - capability flags
   - event stream transport details
4. No silent fallback:
   - incompatible ranges must return typed `LUCIDA_VERSION_MISMATCH`.

## 4. Envelope and identity rules

1. Request params include:
   - `protocol_version`
   - `request_id` (UUIDv7)
   - optional `idempotency_key`
2. Server resource IDs are UUIDv7.
3. Event envelope includes:
   - `session_id`
   - `event_id`
   - `event_type`
   - `session_seq` (u64 semantic, modeled as non-negative integer)
   - `emitted_at`

## 5. Idempotency policy

1. Mutating methods require `idempotency_key`.
2. Non-mutating methods must not require `idempotency_key`.
3. Retry-safe behavior is keyed by `(session_id, method, idempotency_key)`.

## 6. Explicit view model

1. Views are explicit resources in v1.
2. New view lifecycle methods:
   - `view.create`
   - `view.close`
   - `view.get`
3. View-to-layer binding methods:
   - `view.bind_layer`
   - `view.unbind_layer`
4. View-scoped controls require `view_id`:
   - `view.set_axis_index`
   - `view.reorder_axes`
   - `view.set_channel_order`
   - `camera.set_mode`
   - `camera.set_pose`
   - `camera.get`
   - `selection.get`
   - `selection.set`
5. Multi-dataset overlay and side-by-side workflows are modeled through multiple views and explicit layer bindings.
6. `dataset.open.axis_map` is strict source-axis remapping:
   - unknown source axes are rejected
   - duplicate canonical targets are rejected
   - invalid mappings fail with `LUCIDA_INVALID_PARAMS`

## 7. Async jobs

1. Long-running operations return immediately with:
   - `job.job_id`
   - `job.accepted_at`
   - `job.state = "queued"`
   - includes `dataset.open`, `dataset.export`, layer creation calls, and replay/import operations
2. Job lifecycle states:
   - `queued`
   - `running`
   - `completed`
   - `failed`
   - `cancelled`
3. Progress and lifecycle updates are delivered via dedicated event stream.
4. Job state recovery is done through `job.get` and `job.list`.

## 8. Large payload policy

1. Bulk numeric payloads must be out-of-band via `DataRef`.
2. `DataRef.kind`:
   - `shared_memory`
   - `temp_file`
   - `uri`
3. `DataRef` includes shape/dtype/endianness/compression/ttl/checksum metadata.
4. Inline JSON payload budget is capped at `65536` bytes for control-sized payloads.

## 9. Typed error contract

Error envelope schema lives at `protocol/schemas/errors/error.schema.json`.

Codes:

1. `LUCIDA_INVALID_PARAMS`
2. `LUCIDA_NOT_FOUND`
3. `LUCIDA_CONFLICT`
4. `LUCIDA_VERSION_MISMATCH`
5. `LUCIDA_UNSUPPORTED_CAPABILITY`
6. `LUCIDA_BUSY`
7. `LUCIDA_TIMEOUT`
8. `LUCIDA_INTERNAL`
9. `LUCIDA_IO_FAILURE`
10. `LUCIDA_AUTH_REQUIRED`
11. `LUCIDA_AUTH_DENIED`

Every error includes:

1. `code`
2. `message`
3. `details`
4. `retryable`
5. optional `retry_after_ms`

## 10. Command log format

1. Command logs are JSONL.
2. One line equals one record validated by:
   - `protocol/command-log/lucida.commandlog.v1.schema.json`
3. Records are either:
   - `kind = "command"`
   - `kind = "event"`
4. Replay must validate protocol compatibility before applying records.

## 11. Versioning rules

1. The in-repo contract currently uses protocol version `1.0.0` in pre-release mode.
2. During pre-release, additive method/field changes may evolve in-place under `1.0.0`.
3. Breaking changes still require a new major version line.
4. OpenRPC/schema artifacts in this repo are always the authoritative live contract.

## 12. Current v1.0.0 method list (pre-release mutable)

1. `system.hello`
2. `system.capabilities.get`
3. `session.create`
4. `session.close`
5. `session.get`
6. `dataset.open`
7. `dataset.close`
8. `dataset.get`
9. `dataset.export`
10. `layer.add_image`
11. `layer.add_points`
12. `layer.update`
13. `layer.remove`
14. `layer.get`
15. `view.create`
16. `view.close`
17. `view.get`
18. `view.bind_layer`
19. `view.unbind_layer`
20. `view.set_axis_index`
21. `view.reorder_axes`
22. `view.set_channel_order`
23. `camera.set_mode`
24. `camera.set_pose`
25. `camera.get`
26. `selection.get`
27. `selection.set`
28. `job.get`
29. `job.cancel`
30. `job.list`
31. `events.subscribe`
32. `command_log.export`
33. `command_log.import`
34. `command_log.replay`

## 13. Step 03 method contract details

1. `dataset.open`:
   - `axis_map` is strict `source_axis -> canonical_axis` remapping.
   - unknown source labels, empty targets, and duplicate mapped labels fail with `LUCIDA_INVALID_PARAMS`.
   - optional remote IO knobs: `timeout_ms` (positive int), `max_retries` (non-negative int).
2. `dataset.get`:
   - additive optional metadata fields in current `1.0.0` line:
     - `backend` (`local|http|s3|gcs|synthetic`)
     - `ngff` (`ngff_version`, `zarr_format`, `multiscales` summary)
     - `cache` (`chunk_capacity_bytes`, `chunk_used_bytes`, `metadata_entries`, counter set)
3. `dataset.export`:
   - required request fields: `protocol_version`, `request_id`, `idempotency_key`, `session_id`, `dataset_id`, `destination_uri`.
   - optional request fields: `overwrite`, `timeout_ms`, `max_retries`.
   - response shape: `{ session_id, job }` using the standard async accepted envelope.
   - completion event: `dataset.exported` with `dataset_id`, `destination_uri`, and `job_id`.

## 14. Step 04 behavior notes (no schema changes)

1. Step 04 does not add methods or fields; behavior is defined behind existing contracts.
2. 2D display plane selection:
   - renderer uses the last two labels in `view.axis_order` as displayed axes.
   - non-displayed axes are resolved via `view.axis_indices`.
   - user-facing X/Y selection is therefore controlled through `view.reorder_axes`.
3. 2D channel traversal and compositing:
   - `view.set_channel_order` controls channel traversal order for 2D planning.
   - `layer.update` changes to `visible` and `opacity` participate in style invalidation and compositing output.
4. Panzoom camera semantics:
   - `camera.set_pose` in `panzoom` mode is canonicalized so `target[0:2]` is the pan center.
   - effective zoom derives from `1 / max(position[2] - target[2], 1e-6)`.
   - `camera.get` in `panzoom` mode returns canonical pose representation.

## 15. Step 05 behavior notes (no schema changes)

1. Step 05 does not add methods or fields; behavior is defined behind existing contracts.
2. 3D volume-axis selection:
   - planner uses the last three labels in `view.axis_order` as volume axes.
   - non-volume axes are resolved via `view.axis_indices`.
   - source normalization remains `dataset.open.axis_map`.
3. 3D camera semantics:
   - `camera.set_mode` and `camera.set_pose` in `arcball` and `freefly` modes canonicalize finite pose vectors.
   - `camera.get` returns canonicalized `position`, `target`, normalized `up`, and optional `fov_degrees`.
   - Step 05 camera policy is full 6DOF for both `arcball` and `freefly`.
4. 3D render controls through existing `layer.update.patch` keys:
   - `render_mode`: `mip|alpha|iso` (default `mip`)
   - `iso_threshold`: `[0,1]` (default `0.5`)
   - `density_scale`: `>0` (default `1.0`)
   - `sample_step`: `>0` (default `1.0`)
5. Invalidation/coalescing policy is unchanged from Step 04:
   - kinds remain `full`, `slice`, `style`, `camera`
   - Step 05 render-control patch updates map to `style`
   - one coalesced plan update per view per dispatch cycle
