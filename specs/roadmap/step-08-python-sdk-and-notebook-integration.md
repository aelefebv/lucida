# Step 08 Sub-Spec: Python SDK and Notebook Integration

## Objective
Implement a synchronous typed Python SDK that controls Lucida daemon sessions from scripts and notebooks with strict protocol parity, ergonomic helper APIs, and deterministic event handling semantics.

## What Lives in This Sub-Spec
1. SDK client lifecycle (`launch_or_connect`, `connect`, explicit local daemon shutdown).
2. 1:1 protocol method wrappers (`domain.method` -> `domain_method`).
3. Required ergonomic helpers (`session_scope`, `wait_for_job`, `subscribe_events`).
4. SDK exception hierarchy mapped from protocol error envelopes.
5. Strict event polling and `session_seq` continuity checks.
6. Notebook documentation and runnable notebook smoke workflow.

## Scope
In scope:
1. Python SDK package under `python/lucida_sdk/`.
2. In-process daemon transport adapter for Step 08.
3. Process-local daemon registry for `launch_or_connect` fallback behavior.
4. Command-log method wrappers exposed at SDK surface.
5. Step-08 SDK tests and notebook smoke execution coverage.

Out of scope:
1. OpenRPC/schema method/field changes.
2. External IPC transport implementation (scaffold only in Step 08).
3. Asyncio-first client architecture (synchronous client is canonical).
4. Non-Python official SDKs.
5. Step-09 command-log runtime semantics implementation.

## Protocol and Interface Policy
1. Step 08 is behavior-only at protocol artifact boundary:
   - no changes to `protocol/openrpc/lucida.v1.openrpc.json`
   - no request/response/event schema deltas
2. SDK must stay aligned with active protocol line `1.0.0`.
3. Coverage policy:
   - every OpenRPC method is exposed by the SDK as a 1:1 wrapper
   - parity is enforced by tests against OpenRPC method list
4. Generated protocol models remain schema-derived and freshness-checked in CI.

## Runtime Architecture
1. Transport model is hybrid:
   - define transport interface for commands + events
   - implement `InProcessDaemonTransport` in Step 08
   - keep `IpcTransport` scaffolded and explicitly unsupported in Step 08
2. `launch_or_connect` daemon policy:
   - resolve process-local daemon entry by `local_ipc_uri`
   - create and register local daemon if missing
   - auto-launched daemon persists after client close
   - daemon teardown is explicit via `shutdown_local_daemon(...)`
3. `connect` policy:
   - attach only to an existing daemon target (registry/daemon/transport)
   - never implicitly launch a daemon
4. Handshake policy:
   - `connect` and `launch_or_connect` auto-run `system.hello`
   - `system.capabilities.get` is fetched during setup

## SDK API Contract
1. Canonical constructor surface:
   - `launch_or_connect(...)`
   - `connect(...)`
   - `shutdown_local_daemon(...)`
2. 1:1 protocol wrappers:
   - all methods listed in OpenRPC must exist as `domain_method(...)`.
3. Required helper surface:
   - `session_scope(...)` context helper
   - `wait_for_job(...)`
   - `subscribe_events(...)`
4. Additional ergonomic aliases are allowed if they forward directly to 1:1 wrappers.

## Request Metadata and Idempotency Policy
1. Default request metadata:
   - `protocol_version` defaults to `"1.0.0"`
   - `request_id` defaults to UUIDv7
2. Mutating method default:
   - auto-generate `idempotency_key` when omitted
   - caller-provided idempotency key always takes precedence
3. Non-mutating methods must not auto-inject `idempotency_key`.

## Error Policy
1. SDK errors are represented by `LucidaSdkError` and code-specific subclasses:
   - `InvalidParams`, `NotFound`, `Conflict`, `VersionMismatch`
   - `UnsupportedCapability`, `Busy`, `Timeout`, `Internal`, `IoFailure`
   - `AuthRequired`, `AuthDenied`
2. Protocol/core error envelopes must map deterministically to SDK subclasses.
3. Unknown protocol codes map to base `LucidaSdkError` without data loss.

## Event Policy
1. `subscribe_events(...)` returns a polling subscription handle.
2. `EventSubscription` API:
   - `poll(limit=...)`
   - `iter_events(limit=..., poll_interval_s=..., max_idle_polls=...)`
3. Sequence safety:
   - enforce strict `session_seq` continuity across polls
   - any gap or out-of-order delivery raises typed `EventGapError`
   - wildcard subscriptions are the default path for continuity-safe iteration
4. Backpressure behavior:
   - daemon `LUCIDA_BUSY` errors are surfaced as SDK `Busy`.

## Notebook and Documentation Contract
1. SDK docs are delivered in `docs/sdk/README.md`.
2. Runnable notebook is committed at `docs/sdk/notebooks/step8_core_image_flow.ipynb`.
3. Notebook flow must demonstrate:
   - auto-connect handshake
   - session creation
   - dataset open + job wait
   - image layer add + view bind
   - axis and camera updates
   - event polling
   - explicit cleanup

## Deliverables
1. SDK modules:
   - `python/lucida_sdk/client.py`
   - `python/lucida_sdk/transport.py`
   - `python/lucida_sdk/errors.py`
   - `python/lucida_sdk/events.py`
   - `python/lucida_sdk/registry.py`
   - package exports in `python/lucida_sdk/__init__.py`
2. Step-08 docs and notebook:
   - `docs/sdk/README.md`
   - `docs/sdk/notebooks/step8_core_image_flow.ipynb`
3. SDK test coverage:
   - `tests/sdk/*`
   - OpenRPC parity check in `tests/protocol/test_generated_models.py`

## Test and Acceptance Gates
1. SDK setup and lifecycle:
   - auto-hello behavior on `connect` and `launch_or_connect`
   - explicit daemon shutdown semantics validated
2. API parity:
   - 1:1 wrapper coverage matches OpenRPC method list
3. Idempotency:
   - mutating calls work with autogenerated keys
   - caller overrides are preserved
4. Error mapping:
   - protocol/core errors map to correct SDK exception classes
5. Event behavior:
   - polling and iterator APIs operate over daemon event stream
   - sequence gaps raise `EventGapError`
   - backpressure busy behavior maps correctly
6. Notebook smoke:
   - committed notebook executes code cells end-to-end in tests
7. Generated model freshness:
   - existing generated-model checks remain green

## Dependencies
1. Step 01 protocol artifacts and generated model policy.
2. Step 07 daemon session/event behavior and runtime contracts.

## Exit Criteria
Step 08 is complete when the Python SDK can drive end-to-end image workflows from scripts/notebooks with strict OpenRPC method parity, deterministic error/event behavior, explicit daemon lifecycle control, and green Step-08 targeted tests.
