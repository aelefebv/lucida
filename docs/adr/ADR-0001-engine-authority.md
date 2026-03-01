# ADR-0001: Engine Authority

- Status: Accepted
- Date: 2026-03-01

## Context

Lucida has multiple clients (browser, CLI, Jupyter) that can be connected concurrently. The system requires consistent shared state, reproducible history, generation consistency guarantees, and auditable writes.

If clients are allowed to author authoritative shared state independently, conflicting updates and non-reproducible outcomes become likely.

## Decision

The Lucida Engine is the single authoritative owner of shared session state, revision ordering, and policy enforcement.

Clients may predict local view-state updates for responsiveness, but they must reconcile to engine-emitted authoritative events.

## Consequences

- Shared state changes are globally ordered and attributable.
- Multi-client behavior is deterministic under the same event stream.
- Engine complexity increases because validation and ordering are centralized.
- Frontend implementations stay thinner and interoperable because they do not define independent truth models.

## Alternatives Considered

- Client-authoritative with conflict resolution: rejected due to complexity and weaker correctness guarantees.
- Peer-to-peer authority: rejected due to hard audit and consistency requirements.
