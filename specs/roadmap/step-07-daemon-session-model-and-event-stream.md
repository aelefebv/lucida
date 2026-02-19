# Step 07 Sub-Spec: Daemon Session Model and Event Stream

## Objective
Run Lucida as a long-lived process with multi-session lifecycle management and reliable event delivery.

## What Lives in This Sub-Spec
- Daemon startup/shutdown and session lifecycle.
- Request routing, concurrency model, and backpressure rules.
- Dedicated event stream behavior and subscription handling.
- Recovery semantics for reconnecting clients.

## Scope
In scope:
1. Session creation/closure and ownership tracking.
2. Client connection management.
3. Ordered event dispatch guarantees per session.
4. Basic remote bind controls consistent with v1 security posture.

Out of scope:
1. Multi-tenant isolation.
2. Full enterprise auth stack.

## Interface and Contract Changes
- Enforce `events.subscribe` delivery guarantees.
- Enforce handshake-first command requirement.

## Deliverables
1. Daemon runtime module.
2. Session manager and command router.
3. Event stream publisher/subscription manager.
4. End-to-end daemon behavior tests.

## Test and Acceptance Gates
1. Multiple sessions can run without state leakage.
2. Event ordering (`session_seq`) is monotonic and gap-detectable.
3. Reconnect path supports state recovery via query methods.

## Dependencies
- Steps 01-06 contracts and runtime behavior.

## Exit Criteria
Step 07 is complete when external clients can reliably control and observe a long-lived Lucida process.
