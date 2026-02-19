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

## 7. Async jobs

1. Long-running operations return immediately with:
   - `job.job_id`
   - `job.accepted_at`
   - `job.state = "queued"`
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

1. Patch:
   - clarifications and additive non-breaking schema tightening.
2. Minor:
   - additive methods/fields only.
3. Major:
   - any breaking change in required fields, semantics, method signatures, or behavior.

## 12. Frozen v1 method list

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
14. `view.create`
15. `view.close`
16. `view.get`
17. `view.bind_layer`
18. `view.unbind_layer`
19. `view.set_axis_index`
20. `view.reorder_axes`
21. `view.set_channel_order`
22. `camera.set_mode`
23. `camera.set_pose`
24. `camera.get`
25. `selection.get`
26. `selection.set`
27. `job.get`
28. `job.cancel`
29. `job.list`
30. `events.subscribe`
31. `command_log.export`
32. `command_log.import`
33. `command_log.replay`
