# Step 09 Sub-Spec: Command Log Replay

## Objective
Implement deterministic command log export/import/replay over existing protocol v1 contracts so command streams are reproducible workflow artifacts for debugging, validation, and automation.

## What Lives in This Sub-Spec
1. Session-scoped command journal capture and command/event correlation behavior.
2. JSONL command log export/import over local filesystem and memory URI backends.
3. Strict record validation, protocol compatibility checks, and deterministic replay validation.
4. Replay execution with async job lifecycle, dry-run isolation mode, and typed failure reporting.

## Scope
In scope:
1. Runtime behavior for:
   - `command_log.export`
   - `command_log.import`
   - `command_log.replay`
2. Command/event record assembly and deterministic serialization policy.
3. Replay validation policy (strict fail-fast).
4. Import staging model (`import_id` keyed parsed records).
5. Capability flag activation (`command_log_replay = true`).
6. Core/daemon/SDK integration tests for Step 09 behavior.

Out of scope:
1. Undo/redo time-travel UX.
2. New protocol methods or schema fields for command log operations.
3. Cross-process/global memory URI sharing guarantees.
4. Auto-create-session replay mode.

## Protocol and Interface Policy
1. Step 09 is behavior-only at the protocol artifact boundary:
   - no method list changes
   - no request/response/event schema changes
2. Existing contracts remain canonical for:
   - `CommandLogExportRequest/Response`
   - `CommandLogImportRequest/Response`
   - `CommandLogReplayRequest/Response`
   - `command_log.replay` event payload typing
3. Async behavior contract:
   - `command_log.export` is synchronous
   - `command_log.import` and `command_log.replay` are async job operations
4. Capability contract:
   - `system.hello` and `system.capabilities.get` must surface `command_log_replay = true`

## Runtime Architecture
1. Core command-log helpers live in `python/lucida_core/command_log.py`:
   - deterministic JSONL serialization
   - URI resolution/storage
   - strict record validation
   - replay step grouping and event canonicalization helpers
2. Engine integration lives in `python/lucida_core/engine.py`:
   - per-session command journal capture
   - per-session imported-log staging store
   - export/import/replay handlers and replay execution
3. Daemon/SDK do not add protocol surface:
   - they consume Step 09 behavior through existing wrappers and job/event APIs

## URI Policy
1. Supported URI forms:
   - local filesystem paths (relative or absolute)
   - `file://...`
   - `memory://...`
2. Unsupported URI schemes fail with `LUCIDA_UNSUPPORTED_CAPABILITY`.
3. Missing sources fail with typed not-found behavior.
4. File export writes are atomic (`tmp` write + replace in same directory).

## Record Model and Recording Scope
1. Journal capture scope:
   - record only commands that include `session_id`
   - skip `command_log.*` methods to avoid recursive self-capture
2. Correlation model:
   - one generated `correlation_id` per recorded command
   - all events emitted by that command share the same correlation id in exported records
3. Export sequence model:
   - records are flattened as `command` followed by its correlated `event` records
   - `seq` is strictly contiguous and starts at `1`
4. Serialization model:
   - UTF-8 JSONL
   - deterministic key ordering and separators for stable fixture bytes

## Method Semantics

### `command_log.export`
1. Validates `session_id` and destination URI.
2. Materializes flattened records from session journal.
3. Persists JSONL to destination backend.
4. Returns `{session_id, destination_uri, record_count}`.

### `command_log.import`
1. Async accepted response returns `{session_id, import_id, job}`.
2. Job operation:
   - reads source URI
   - parses JSONL lines
   - validates strict record shape and sequence integrity
   - enforces protocol version compatibility
   - stages normalized records under `session.imported_logs[import_id]`
3. Validation is strict fail-fast on the first invalid condition.

### `command_log.replay`
1. Async accepted response returns `{session_id, replay_id, job}`.
2. Replay target policy:
   - applies only to the request `session_id`
   - any command record with a different `request.params.session_id` fails validation
3. Execution policy:
   - validates and groups command+event steps in sequence order
   - re-dispatches command records in order
   - compares emitted events to expected event anchors using canonical event comparison
4. Event comparison policy:
   - compare `event_type` and full `payload`
   - ignore envelope-only nondeterministic fields (`event_id`, `emitted_at`, `session_seq`)
5. Dry-run policy:
   - `dry_run=true` executes in an isolated cloned engine state
   - real target session state is not mutated
6. Replay emits `command_log.replay` events with states:
   - `started`
   - `progress`
   - `completed`
   - `failed`
7. Replay is strict fail-fast:
   - first command failure or event mismatch aborts replay and marks job failed

## Error and Failure Policy
1. Unsupported URI scheme: `LUCIDA_UNSUPPORTED_CAPABILITY`.
2. Missing command log source: typed not-found behavior.
3. Malformed JSON / schema-shape violations / seq integrity violations: `LUCIDA_INVALID_PARAMS`.
4. Protocol version incompatibility: `LUCIDA_VERSION_MISMATCH`.
5. Replay target mismatch or replayed event divergence: `LUCIDA_CONFLICT`.
6. Replay/import job failures are surfaced through:
   - job terminal state `failed`
   - typed error envelope on the job
   - replay failure events for replay jobs

## Deliverables
1. Command-log runtime module:
   - `python/lucida_core/command_log.py`
2. Engine integration and method implementation:
   - `python/lucida_core/engine.py`
3. Core Step 09 tests:
   - `tests/core/test_step9_command_log.py`
   - updates in `tests/core/test_nd_state_engine.py`
4. Daemon/SDK behavior integration tests:
   - updates in `tests/daemon/test_step7_daemon_runtime.py`
   - updates in `tests/sdk/test_step8_sdk_client.py`
5. Spec/context updates for Step 09 completion status.

## Test and Acceptance Gates
1. Export -> import -> replay deterministic fixture path yields equivalent view/state outcomes.
2. Import fails fast on malformed JSON and protocol version mismatch with typed errors.
3. Replay fail-fast semantics abort on first event mismatch and emit failed replay state.
4. Dry-run replay leaves target session state unchanged.
5. URI policy enforces local/file/memory support and rejects unsupported schemes.
6. Daemon event stream surfaces import/replay job and replay progress states.
7. SDK command-log wrappers execute end-to-end against runtime Step 09 behavior.

## Dependencies
1. Step 02 deterministic state transitions and event outbox model.
2. Step 07 daemon session/event orchestration for async job/event observability.
3. Step 08 SDK wrapper parity over existing protocol methods.

## Exit Criteria
Step 09 is complete when command-log methods are operational behind existing protocol contracts, replay determinism checks are enforced with strict fail-fast behavior, dry-run replay is isolated and non-mutating, and Step 09 targeted tests are green with context traceability updated to `done`.
