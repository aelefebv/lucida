# ADR-0002: Shared Scene vs Per-Client View State

- Status: Accepted
- Date: 2026-03-01

## Context

Lucida supports simultaneous users and surfaces (browser, notebook, CLI). Directly sharing camera and rendering knobs across users causes interaction conflicts and poor usability.

At the same time, layer stack composition, targets, and shared defaults must remain collaboratively editable and durable.

## Decision

Lucida separates authoritative state into:

- shared scene state
- per-client view state

Shared scene edits require control permission and lease ownership. Per-client view updates do not require lease and do not mutate shared scene state unless explicitly promoted.

## Consequences

- Users can navigate independently without "fighting the mouse."
- Shared artifacts remain coherent and reproducible.
- Protocol and reducers require explicit scope handling for each command.
- UI must clearly indicate when local settings are private vs promoted/shared.

## Alternatives Considered

- Fully shared camera/view state: rejected due to multi-user contention.
- Fully private scene state with optional sync: rejected due to weak collaboration semantics.
