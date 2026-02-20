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

## 16. Step 06 behavior notes (additive schema typing in `1.0.0`)

1. Step 06 keeps the existing method set and adds typed payload structure for points/selection contracts.
2. `layer.add_points` additive request fields:
   - `point_id_ref` (optional point-id vector)
   - `edges_ref` (optional graph edge pairs)
   - `attribute_table_ref` + `attribute_columns`
   - `coordinate_axes`
3. Points-layer data contract:
   - `data_ref.shape` must be `[N, D]` with `D >= 2`
   - points coordinates must use numeric dtype
   - `edges_ref`, when present, must be integer dtype with shape `[E, 2]`
4. Selection payload typing:
   - typed canonical form is `PointsSelectionState`
   - legacy payloads using `indices` remain accepted for compatibility
5. `selection.changed` payload now carries:
   - `view_id`, `selection_version`, `query`, `resolved_count`
   - inline `selected_point_ids` for small selections
   - `selected_point_ids_ref` when selected IDs exceed inline cap (`4096`)
6. Linked selection semantics in Step 06:
   - points selection emits linked image context hooks
   - no automatic camera/slice mutation is performed by the runtime
   - image-to-points bidirectional linking is out of scope
7. Step 06 points-style controls through existing `layer.update.patch` keys:
   - `points_filter` (structured predicate AST)
   - `color_by`, `color_map`
   - `lod_cell_px` (default `2`)
   - `lod_max_points` (default `250000`)
   - `point_size`
8. Invalidation/coalescing policy remains unchanged:
   - kinds remain `full`, `slice`, `style`, `camera`
   - Step 06 points filter/style/LOD patch updates map to `style`
   - one coalesced plan update per view per dispatch cycle

## 17. Step 07 behavior notes (no schema changes)

1. Step 07 does not add methods or fields; behavior is defined behind existing contracts.
2. Handshake-first enforcement at daemon connection boundary:
   - `system.hello` must be first command on a new connection
   - non-hello command before handshake returns `LUCIDA_INVALID_PARAMS`
3. Session ownership semantics:
   - `session.create` owner metadata is tracked by daemon
   - ownership is informational only in Step 07 (no write lock)
4. Session routing semantics:
   - command execution is serialized per `session_id`
   - distinct sessions may execute concurrently
5. Event delivery semantics for `events.subscribe`:
   - daemon publishes ordered per-session event deltas from runtime outbox
   - topic filtering is strict to subscription `topics`
   - `session_seq` remains monotonic and gap-detectable
6. Backpressure semantics:
   - per-subscription bounded queue default is `1024`
   - overflow disconnects subscriber; subsequent poll attempts return typed busy error
7. Session close + retention semantics:
   - `session.close` transitions session to `closed`
   - closed sessions reject mutating commands with `LUCIDA_CONFLICT`
   - query/read methods remain available during retention window
   - daemon removes expired closed sessions after default `60` second TTL
8. Remote bind policy in Step 07:
   - local IPC is production path
   - remote listener enablement is deferred and returns unsupported behavior in this step

## 18. Step 08 behavior notes (no schema changes)

1. Step 08 does not add methods or fields; behavior is implemented as SDK-client policy around existing contracts.
2. SDK method mapping policy:
   - every OpenRPC method is exposed as a 1:1 Python wrapper (`domain.method` -> `domain_method`)
3. SDK constructor policy:
   - `connect(...)` and `launch_or_connect(...)` auto-run `system.hello`
   - setup includes capability fetch via `system.capabilities.get`
4. SDK request metadata defaults:
   - `protocol_version` defaults to `1.0.0`
   - `request_id` defaults to UUIDv7
   - mutating methods auto-generate `idempotency_key` unless caller provides one
5. SDK local daemon lifecycle policy:
   - `launch_or_connect(...)` may auto-start a process-local daemon target
   - client close disconnects connection only
   - daemon shutdown is explicit through SDK helper API
6. SDK event helper policy:
   - event subscriptions are poll/iterator driven
   - SDK enforces strict `session_seq` continuity and raises typed gap errors on violations
   - wildcard topic subscriptions are the default continuity-safe mode
7. External IPC SDK transport remains scaffold-only in Step 08 and is explicitly unsupported.

## 19. Step 09 behavior notes (no schema changes)

1. Step 09 does not add methods or fields; behavior is defined behind existing command-log contracts.
2. Capability policy:
   - `system.hello` and `system.capabilities.get` report `command_log_replay = true` when Step 09 behavior is active.
3. Recording policy:
   - runtime records session-scoped commands (`session_id` present) and their resulting events.
   - `command_log.*` methods are excluded from journal capture to avoid recursive logs.
4. Export policy (`command_log.export`):
   - response is synchronous with `{session_id, destination_uri, record_count}`.
   - record stream is JSONL with contiguous `seq` starting at `1`.
   - deterministic serialization is used for stable fixture bytes.
5. URI policy:
   - supported: local path, `file://`, `memory://`.
   - unsupported URI schemes return `LUCIDA_UNSUPPORTED_CAPABILITY`.
6. Import policy (`command_log.import`):
   - async job validates JSONL record shape, sequence integrity, and protocol compatibility.
   - successful imports stage normalized records under `import_id` for session-local reuse.
   - malformed records fail fast with typed validation errors.
7. Replay policy (`command_log.replay`):
   - async job replays command records in order against the target session.
   - replay validates `request.params.session_id` for every command against request `session_id`.
   - replay uses strict fail-fast validation against expected event anchors.
   - replay event envelope `command_log.replay` emits states: `started`, `progress`, `completed`, `failed`.
8. Dry-run replay policy:
   - `dry_run=true` executes replay against an isolated cloned runtime state.
   - dry-run does not mutate the live target session state.
9. Failure signaling:
   - replay/import failures surface through standard `job.lifecycle` failed state and typed error envelopes.
   - replay additionally emits a terminal `command_log.replay` event with `state = failed`.

## 20. Step 11 behavior notes (no schema changes)

1. Step 11 keeps OpenRPC/schema artifacts unchanged.
2. Remote browser access is implemented through `lucida_gateway` WS envelopes over existing daemon methods/events.
3. Gateway endpoints:
   - `GET /healthz`
   - `GET /v1/ws` (token required)
4. Gateway frame types:
   - `attach`
   - `rpc.request`
   - `rpc.response`
   - `rpc.error`
   - `event`
   - `render.tile`
   - `render.status`
5. Attach semantics:
   - browser attaches by explicit `session_id` + `view_id`
   - gateway enforces one active controller per session
6. RPC relay semantics:
   - gateway forwards existing Lucida methods behind the same typed error envelopes
   - requests with mismatched `session_id` against attached session are rejected with typed conflict
7. Event semantics:
   - gateway manages daemon `events.subscribe` lifecycle
   - forwarded events preserve source ordering and `session_seq` continuity
8. Render semantics:
   - Step 11 streams true 2D image-layer pixels as changed tiles (`256px`)
   - default encoding is `jpeg` (quality `75`) with `png` fallback
   - render updates are throttled to `15` Hz per connection
9. Degradation policy:
   - bounded render queue drops stale frames first
   - repeated overflow can close slow connections with backpressure signaling
10. Security posture:
   - localhost bind default
   - non-local bind requires explicit TLS-termination mode
   - daemon native `remote_bind` remains unsupported; gateway is the remote path
