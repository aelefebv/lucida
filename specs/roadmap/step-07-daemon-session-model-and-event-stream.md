# Step 07 Sub-Spec: Daemon Session Model and Event Stream

## Objective
Implement a behavior-first daemon runtime over existing protocol v1 contracts, with deterministic connection/session orchestration, ordered topic-filtered events, bounded backpressure behavior, and reconnect-safe recovery via query APIs.

## What Lives in This Sub-Spec
1. Daemon runtime process model and local IPC startup semantics.
2. Connection lifecycle and handshake-first command enforcement.
3. Session lifecycle policy, ownership metadata tracking, and retention/GC rules.
4. Session routing model (`serial per session`, concurrent across sessions).
5. Event publisher/subscription semantics with topic filtering and bounded queues.
6. Backpressure disconnect behavior and reconnect recovery expectations.
7. Rust daemon crate scaffold for migration planning.

## Scope
In scope:
1. Python daemon package at `python/lucida_daemon/`.
2. Integration with existing deterministic command/state authority in `python/lucida_core/engine.py`.
3. Handshake-gated command channel behavior.
4. Ordered event delivery from existing `events.subscribe` contract.
5. Session close retention defaults and GC behavior.
6. Local IPC endpoint configuration and startup metadata.
7. Cross-platform smoke testing for daemon startup and command/event roundtrip.
8. Rust `lucida-daemon` scaffold crate and workspace registration.

Out of scope:
1. OpenRPC/schema method or field additions.
2. Remote TCP/WebSocket listener implementation (owned by Step 11).
3. Session write-lock policy (owner metadata is tracked only).
4. Command-log replay behavior (owned by Step 09).
5. Python SDK ergonomics/notebook API surface (owned by Step 08).
6. Multi-tenant security/isolation architecture.

## Protocol and Interface Policy
1. Step 07 is behavior-only at the protocol artifact boundary:
   - no changes to `protocol/openrpc/lucida.v1.openrpc.json`
   - no request/response/event schema delta
2. Existing methods define the daemon-facing behavior surface:
   - `system.hello`
   - `session.create`, `session.close`, `session.get`
   - `events.subscribe`
   - existing query methods used for reconnect recovery
3. Handshake policy:
   - non-`system.hello` command on a new connection returns `LUCIDA_INVALID_PARAMS`.
4. Closed-session behavior policy:
   - mutating commands on closed sessions return `LUCIDA_CONFLICT`
   - query/read methods remain allowed during retention window
   - sessions are eventually removed by TTL GC and then return `LUCIDA_NOT_FOUND`

## Runtime Architecture
1. `LucidaDaemon` is the orchestration entrypoint for Step 07.
2. Core command execution remains delegated to `NDStateEngine`.
3. Connection manager responsibilities:
   - track connection identity and handshake state
   - persist client metadata (`client_name`, `client_version`) from `system.hello`
4. Session router responsibilities:
   - serialize commands per `session_id`
   - permit concurrent execution across distinct sessions
5. Event publisher responsibilities:
   - register subscriptions by session/topic
   - publish ordered event deltas from per-session outboxes
   - apply bounded queue policy with overflow disconnect
6. IPC adapter responsibilities:
   - normalize and expose local endpoint metadata
   - support `unix_socket://` (POSIX) and `named_pipe://` (Windows abstraction)
7. Retention GC responsibilities:
   - track `session.close` timestamps
   - remove expired closed sessions after configured TTL

## Session and Ownership Semantics
1. `session.create` records session ownership metadata:
   - creating `connection_id`
   - hello metadata (`client_name`, `client_version`) when present
2. Ownership is informational only in Step 07:
   - non-owner authenticated clients may mutate/query the same session
3. `session.close` transitions session state to `closed`.
4. Default closed-session retention is `60` seconds.
5. After retention expiry, daemon drops session state and related subscription buffers.

## Event Delivery and Backpressure Semantics
1. Event source of truth is the existing session outbox in core runtime.
2. Daemon tracks per-session event offsets and publishes only new events.
3. Delivery filtering is topic-based from `events.subscribe.topics`.
4. Ordering guarantee:
   - events delivered to each subscription preserve source order
   - `session_seq` remains monotonic per session
5. Backpressure policy:
   - per-subscription bounded queue (`default=1024`)
   - overflow disconnects subscriber and clears pending queue
   - polling a disconnected subscription returns typed busy error
6. Reconnect recovery model:
   - daemon does not offer replay cursors in Step 07
   - clients detect gaps via `session_seq` and recover using existing query methods

## Remote Bind Policy
1. Remote bind config surface exists for future compatibility.
2. Enabling remote bind in Step 07 is rejected as unsupported and deferred to Step 11.
3. Localhost/local IPC remains the production transport scope for Step 07.

## Deliverables
1. Python daemon package:
   - `python/lucida_daemon/config.py`
   - `python/lucida_daemon/connection.py`
   - `python/lucida_daemon/router.py`
   - `python/lucida_daemon/events.py`
   - `python/lucida_daemon/ipc.py`
   - `python/lucida_daemon/daemon.py`
   - `python/lucida_daemon/__init__.py`
2. Core runtime support helper methods:
   - `python/lucida_core/engine.py`
3. Step 07 daemon test coverage:
   - `tests/daemon/test_step7_daemon_runtime.py`
4. Step 07 CI workflow:
   - `.github/workflows/step7-daemon.yml`
5. Rust daemon scaffold:
   - `rust/crates/lucida-daemon/Cargo.toml`
   - `rust/crates/lucida-daemon/src/lib.rs`
   - `rust/Cargo.toml` workspace update

## Test and Acceptance Gates
1. Handshake gate:
   - pre-hello non-handshake commands fail with `LUCIDA_INVALID_PARAMS`
   - successful hello unlocks command dispatch
2. Multi-session isolation:
   - concurrent commands across sessions do not leak state/events
3. Ordering:
   - delivered event sequence is monotonic by `session_seq`
4. Topic filtering:
   - subscribers receive only configured event topics
5. Backpressure:
   - queue overflow disconnects slow subscriber without crashing session/daemon
6. Reconnect recovery:
   - new connection can recover session/job/view state via query methods
7. Session close/retention:
   - closed sessions reject mutating calls
   - reads remain valid during TTL
   - post-TTL GC removes session and returns not-found behavior
8. Cross-platform smoke:
   - Step 07 daemon tests run on Linux, macOS, and Windows in CI
9. Rust scaffold:
   - workspace check/test includes daemon scaffold crate

## Dependencies
1. Step 01 protocol baseline and schema policy.
2. Step 02 deterministic state/runtime and in-memory event outbox.
3. Steps 03-06 behavior running behind current protocol methods.

## Exit Criteria
Step 07 is complete when a long-lived daemon runtime reliably enforces handshake/session lifecycle rules, provides ordered topic-filtered event delivery with bounded backpressure behavior, supports reconnect recovery via query APIs, and passes Step 07 cross-platform/runtime + Rust scaffold gates without protocol contract changes.
