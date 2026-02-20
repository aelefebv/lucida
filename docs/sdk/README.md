# Lucida SDK (Step 08)

This document defines the Step 08 Python SDK contract implemented in `python/lucida_sdk/`.

## Quickstart

```python
from lucida_sdk import launch_or_connect, shutdown_local_daemon

client = launch_or_connect()
with client.session_scope(label="quickstart") as session_id:
    opened = client.dataset_open(
        session_id=session_id,
        uri="synthetic://image",
        read_only=True,
    )
    job_id = opened["job"]["job_id"]
    client.wait_for_job(session_id=session_id, job_id=job_id)
client.close()
shutdown_local_daemon()
```

## Lifecycle Model

1. `connect(...)` attaches to an existing process-local daemon registry entry.
2. `launch_or_connect(...)` auto-starts a local daemon if missing, otherwise reuses it.
3. Both constructors automatically run `system.hello` and `system.capabilities.get`.
4. Closing a client disconnects only that client connection.
5. Auto-launched daemons remain running until `shutdown_local_daemon(...)` is called.

## API Shape

1. Every protocol method is available as a 1:1 wrapper:
   - `domain.method` -> `domain_method(...)`
2. Step-08 ergonomic aliases are also available:
   - `create_session`, `open_dataset`, `add_image_layer`, `create_view`, and related helpers.
3. Required Step-08 helpers:
   - `session_scope(...)`
   - `wait_for_job(...)`
   - `subscribe_events(...)`
   - `shutdown_local_daemon(...)` (module-level helper)

## Request Defaults

1. `protocol_version` defaults to `"1.0.0"` when omitted.
2. `request_id` defaults to generated UUIDv7.
3. Mutating calls auto-generate `idempotency_key` unless provided by the caller.

## Error Handling

SDK calls raise `LucidaSdkError` subclasses mapped from protocol error codes:

1. `InvalidParams`
2. `NotFound`
3. `Conflict`
4. `VersionMismatch`
5. `UnsupportedCapability`
6. `Busy`
7. `Timeout`
8. `Internal`
9. `IoFailure`
10. `AuthRequired`
11. `AuthDenied`

Event continuity violations raise `EventGapError`.

## Event Subscription Helpers

Use `subscribe_events(...)` for topic-filtered polling:

```python
subscription = client.subscribe_events(
    session_id=session_id,
    topics=["*"],
)
events = subscription.poll(limit=32)
for event in subscription.iter_events(max_idle_polls=3):
    print(event["event_type"], event["session_seq"])
```

`EventSubscription` enforces strict `session_seq` continuity. Any gap or out-of-order sequence raises `EventGapError`.
For strict continuity checks, wildcard topic subscriptions are the safest default.

## Command-Log Methods

Command-log wrappers are exposed now:

1. `command_log_export`
2. `command_log_import`
3. `command_log_replay`

Step 09 runtimes implement these methods with:

1. synchronous export response with `record_count`
2. async import/replay jobs
3. replay progress events (`command_log.replay`)

## Notebook Example

See the runnable notebook at:

`docs/sdk/notebooks/step8_core_image_flow.ipynb`
