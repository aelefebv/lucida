---
type: Flow
title: "Flow: Document Command Application"
description: "Admission, durable sequencing, publication, and recovery for shared DocumentCommand mutations"
tags: [lucida, flow]
source_path: wiki/flows/document-command-application.md
created: 2026-04-18
modified: 2026-07-16
---

# Flow: Document Command Application

This is the path a shared `DocumentCommand` takes from a local interaction to a
durable workspace revision observed by every connected client. The important
boundary is in the server: a command is validated and persisted before it can
advance the live sequence or be published.

## Trace

1. **Construct and optimistically apply.** The web client builds a
   `DocumentCommand`, applies it to its local Scene for immediate feedback, and
   sends `{type: "command", request_id, command}`. Current clients generate one
   stable request id per send. The Rust protocol still accepts the older
   envelope without `request_id` during rolling upgrades.
2. **Admit bounded work.** `handler.rs` rejects an oversized WebSocket frame
   before JSON decoding, validates the command against the shared limits in
   `lucida-core/src/quota.rs`, and acquires the connection/principal work
   permits. An admitted command is then checked against workspace role and
   content-ownership policy.
3. **Stage without publishing.** `WorkspaceManager::apply_document_command`
   holds the workspace commit boundary and asks the Session for a non-cloneable,
   opaque `StagedDocumentCommit`. Constructing that capability clones the
   canonical document, applies the policy-sanitized command with
   `DocumentState::try_apply`, validates and bounded-serializes the complete
   result, allocates the next sequence, and precomputes history/inverse
   metadata. The live Session is still unchanged.
4. **Persist with an exact predecessor.** The workspace store transaction
   updates `document_json` and `seq` only when the stored sequence is exactly
   the proposed revision's predecessor. A skipped revision, replay, or stale
   writer therefore affects zero rows and fails the mutation.
5. **Consume the commit capability.** Only after the database transaction
   succeeds, `Session::commit_staged_document` consumes the opaque token and
   installs its document, sequence, precomputed history entry, and capability
   removals together. This path performs no apply, validation, serialization,
   comparison, sequence arithmetic, or other fallible work after persistence.
6. **Publish an explicit result.** The author receives
   `Ack {request_id, seq}` and peers receive
   `CommandBroadcast {seq, command}`. A validation, authorization, overload, or
   persistence failure instead returns a correlated
   `Nack {request_id, code, message, retryable}` and publishes no revision.
7. **Drain through the bounded socket outbox.** Each connection has a
   128-message/32-MiB outbox and a send deadline. A client that cannot keep up
   is closed with an overload response rather than accumulating unbounded
   memory. `/metrics/websockets` exposes aggregate queue, rejection, and slow
   consumer counters without client or workspace identifiers.
8. **Reconcile the optimistic client.** An Ack retires that exact pending
   request. A Nack retires only the rejected request, reports the failure, and
   requests an authoritative snapshot so the optimistic local state is
   replaced. Peers apply the broadcast normally.

## Why staging is centralized

The same validation and durable publication boundary is used by normal
commands, inverse commands, dataset membership mutations, and restored
documents. Keeping the sequence in one place prevents three dangerous splits:

- a handler cannot broadcast a command that the workspace database rejected;
- a persistence adapter cannot accept a document that the live Session would
  reject; and
- a caller cannot advance a sequence by skipping over a failed revision.

The workspace lock currently spans staging and the asynchronous store
transaction. This deliberately trades some same-workspace concurrency for a
single, auditable commit order. Work across different workspaces remains
independent, and connection/principal admission keeps one caller from creating
unbounded queued transactions.

## Special case: `DatasetOpened`

`DatasetOpened` is server-originated after an `OpenRemoteDataset` request. The
server builds the binding, stages the document and workspace-dataset row,
persists them in one transaction, then commits the live revision through the
same durable boundary.

The requester receives one `OpenDatasetSucceeded` response containing a small
`summary` plus the legacy full `opened` payload for rolling wire compatibility.
It does not also receive the `CommandBroadcast`. Peers receive the full
`DatasetOpened` command broadcast. This avoids making the requester apply the
same full payload twice while keeping older clients able to initialize from
`opened`.

## Sequence gaps and snapshot recovery

Database commit order is strict, but socket delivery can still be reordered:
one handler can be descheduled after committing sequence `S` while another
publishes `S + 1`. The web Bridge therefore buffers short-lived gaps instead of
treating the first out-of-order message as loss. A gap that survives the grace
window triggers one throttled `RequestSnapshot`, retried while the gap remains.

The server also pushes a fresh snapshot when a client falls behind the bounded
broadcast stream. After adopting snapshot sequence `S`, the client drops
sequenced messages at or below `S`, applies buffered messages above it in
order, and replays only its still-pending optimistic commands. Pending commands
are keyed by `request_id`, so out-of-order Acks cannot retire the wrong command.
A Nack removes its command before requesting the snapshot.

Snapshots are built through the 32-MiB bounded serializer. If the complete
authoritative state cannot fit, the server closes the connection instead of
allocating or sending an unbounded message.

## Invariants

- **Durability precedes visibility.** No Ack, peer broadcast, live sequence
  advance, or history append occurs before persistence succeeds.
- **Failure is atomic.** Validation, authorization, sequence conflict, and
  persistence failures leave the database and live document unchanged.
- **Stored revisions are contiguous.** Persistence requires the exact previous
  sequence; skips, regressions, and replays are rejected.
- **Results are request-correlated.** Current command envelopes, Acks, and Nacks
  carry `request_id`. Missing ids remain readable only for pre-correlation wire
  compatibility.
- **Admission is bounded at every retained boundary.** Frames, commands,
  documents, snapshots, outstanding work, live connections, and socket queues
  all have explicit limits and deterministic overload behavior.
- **Delivery order is not assumed to be sequence order.** Consumers use the
  reorder window and authoritative snapshots rather than applying a newer
  revision across an unresolved hole.

## Proof points

- `lucida-core` quota/command tests prove atomic rejection and bounded
  serialization across command and restored-document variants.
- `lucida-server` workspace tests inject store failures and race a rejected
  mutation with the next successful one; the acknowledged revision remains
  contiguous and both live and stored documents agree.
- Handler/outbox tests saturate the per-connection and per-principal work
  budgets, cancel work, and flood 10,000 messages without exceeding the byte
  ceiling.
- Rust wire goldens plus the web and Python fixture tests lock the correlated
  shapes and the pre-correlation compatibility forms.

## Related

- [Workspaces](../systems/subsystems/workspaces.md)
- [Scene State and Epochs](../systems/subsystems/scene-state-and-epochs.md)
- [Document vs Viewport Command Split](../decisions/0001-document-vs-viewport-split.md)
- [lucida-server](../systems/crates/lucida-server.md)
- [lucida-core](../systems/crates/lucida-core.md)
