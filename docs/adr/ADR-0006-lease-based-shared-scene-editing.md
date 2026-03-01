# ADR-0006: Lease-Based Shared Scene Editing

- Status: Accepted
- Date: 2026-03-01

## Context

Multiple control-capable clients may concurrently edit shared scene state. Without floor control, shared scene edits can conflict in ways that are difficult to reason about operationally.

Lucida also requires fast derived chunk publishing workflows that should not be blocked by scene-edit lock ownership.

## Decision

Lucida uses a lease model for shared scene edits:

- shared scene edits require control permission plus active lease ownership
- any control client may request or steal the lease
- lease changes are passive notifications and audit logged
- derived chunk publishing requires control permission but does not require lease

## Consequences

- Shared scene ownership is explicit and user-visible.
- Deadlock risk is reduced by explicit steal semantics.
- Clients need clear UX for lease state and ownership transitions.
- Audit log provides attribution for lease changes and scene writes.

## Alternatives Considered

- No lease (optimistic concurrent scene edits): rejected due to ambiguous conflict behavior.
- Strict single controller with no steal: rejected due to operational deadlock and usability risk.
