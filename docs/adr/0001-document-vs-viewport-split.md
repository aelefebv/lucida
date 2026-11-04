# Document vs Viewport Command Split

Status: Accepted.

## Context

Several clients share one session. Some state must agree across all of them: which datasets are open, their layouts, their asset catalogs. Other state belongs to one viewer: where they have panned, which timepoint they are on, their display settings. The two kinds need different ordering, durability, and treatment when a new client joins.

## Decision

State mutations are split into two disjoint enums in `lucida-core/src/command.rs`.

`DocumentCommand` is shared. The server sequences it, increments `seq`, acknowledges the sender, keeps it in a 256-entry history ring, and broadcasts it to every client. Examples: `DatasetOpened`, `RemoveDataset`, `RegisterLayout`, `SetActiveLayout`.

`ViewportCommand` is local. The client applies it at once and emits the result as ephemeral presence, where the latest update wins. Examples: `Pan`, `ZoomBy`, `SetT`, `SetGamma`.

`ClientMessage::Command` carries a `DocumentCommand`, so the server has no path that applies a viewport command, and "is this shared?" is answered by the type. A new client's `Snapshot` carries document state and none of another viewer's camera. An untagged `Command` wrapper accepts either shape at JSON boundaries such as the CLI and the Python client.

Classifying a new command is part of adding it. A viewport change sent as a document command makes clients fight over the camera. A document change applied as a viewport command never reaches peers.

## Rejected alternatives

- One `Command` enum with a per-variant shared or local flag. The type system cannot enforce the flag, so every server handler would need a runtime guard.
- Server-side classification by a runtime predicate. An earlier `is_document_command()` check did this. It went away once the wire message carried `DocumentCommand` directly, which made the guard unnecessary.
