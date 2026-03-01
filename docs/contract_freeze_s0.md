# Lucida S0 Contract Freeze Record

Version: 0.1  
Date: 2026-03-01  
Status: Accepted for S0 implementation

## 1. Purpose

This document records the S0 contract freeze outcome for:
- `docs/protocol_and_schemas.md`
- `docs/sequences.md`

It fulfills `LUC-000` deliverables:
- reviewed protocol doc
- reviewed sequence doc
- list of frozen contracts
- list of explicitly deferred items

## 2. Review Outcome

- No unresolved schema blockers remain for engine/client ticket work to begin.
- Command-level gesture transactions are now explicit protocol commands (`gesture.begin`, `gesture.update`, `gesture.end`) to match sequence and history semantics.
- Implementation choices that do not affect JSON object boundaries, required fields, or invariants are explicitly deferred.

## 3. Frozen Contracts (Stable)

Unless listed in Section 4 or Section 5, contract fields and invariants in the reviewed protocol and sequence docs are treated as stable.

Stable contract groups:
- Identifier model: opaque IDs with stable identity classes.
- Revision model: `session_rev`, `scene_rev`, `view_rev`, `layer_rev`, `metadata_rev`, `write_rev`, `generation_seq`.
- Control-plane envelopes: `command`, `command_ack`, `event`, `error`, `heartbeat`, `session.snapshot`.
- Authoritative state model: session, lease state, client roster, shared scene, per-client view, layer/source/dataset objects.
- Event taxonomy and ordering semantics.
- Warning and typed error taxonomy object shapes.
- Chunk key object and logical data-plane addressing rules.
- Generation consistency invariants and source-watch lifecycle semantics.
- Sequence semantics for:
  - attach/snapshot/capability handshake
  - add source and first 2D bootstrap
  - source update to new working generation with no mixed-generation frame
  - 2D navigation prediction/reconciliation/checkpoint behavior
  - reconnect and snapshot recovery behavior

## 4. Explicitly Deferred (Non-Blocking)

The following are intentionally deferred implementation choices and are not schema blockers:

- Control-plane transport selection (`WebSocket` vs `WebTransport`).
- Exact WebSocket subprotocol name.
- Heartbeat interval values and replay retention duration.
- Data-plane serving mode in a deployment (engine-served vs static-object-backed URLs).
- Exact binary payload header layout.
- Exact compression library choices used by clients.
- Upload preparation surface style (control-plane command vs REST endpoint vs both).
- Exact admin endpoint URL shape.
- Exact non-browser auth header shape.
- Large metadata-result transport strategy (pagination vs downloadable object materialization).
- Filter bitset transport representation for very large result sets (inline vs side-band payload object).
- Context package capture implementation location (client-side, engine-side, hybrid).
- Builder progress granularity.
- Storage-level choices that preserve logical contracts (for example exact Zarr version/codec stack, eager vs lazy object projection details).

## 5. Provisional Schema Extension Points

The following are provisional by design and may evolve additively:

- Capability advertisement payload contents in attach flow.
- Warning and error code enum expansion (additive only).
- Command family namespace expansion (additive operations only; existing operation names remain stable).
- Optional metadata fields not marked required by schema rules.

## 6. Contract Change Rules After Freeze

Until S0 completion:
- No breaking changes to stable contract fields or required semantics.
- Any additive change must update both protocol and sequence docs in the same change.
- Any deferred item selected for implementation must preserve stable JSON object boundaries and invariants.

## 7. LUC-000 Deliverable Checklist

- [x] Protocol doc reviewed
- [x] Sequence doc reviewed
- [x] Frozen contracts listed
- [x] Deferred items listed
- [x] No unresolved schema blockers remain for S0 ticket work
