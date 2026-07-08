---
type: Gotcha
title: "Compact Manifest Encoding Is a Decoder One-Way Door"
description: "Manifests/fetch descriptors using the shared-once compact wire form (multiscale/wire-format tables, translation edges) hard-fail on decoders that predate it; rolling back a server strands compact-persisted workspace documents until re-upgrade."
tags: [lucida, gotcha]
source_path: wiki/gotchas/compact-manifest-decoder-one-way-door.md
created: 2026-07-07
modified: 2026-07-07
---

# Compact Manifest Encoding Is a Decoder One-Way Door

## The footgun

`DatasetManifest` and `ProxiedFetchDescriptor` use a shared-once wire form:
multiscales shared by ≥ 2 images move into a top-level `multiscales` table
(per-image `multiscale_ref`), shared wire formats into a `wire_formats` table
(per-image `wire_format_ref`), and pure 2D translation edges serialize as
`translation: [tx, ty]` instead of a 16-element matrix. Decoders that predate
the compact form **hard-reject** every one of these constructs — a
`multiscale_ref` image has no `multiscale` field, so old serde decoding fails
with a "missing field" error. There is no encoder switch to produce the old
fully-inline form.

Because the server persists workspace documents with the same encoder,
**upgrading the server and opening (or touching) a collection makes that
workspace document unreadable by any older binary**. Note the direction: the
compatibility promise for data at rest is old-documents-readable-by-new-code
only, never the reverse.

Note the identity-edge subtlety: an identity self-edge *is* a pure 2D
translation, so even most single-image manifests carry the compact
`translation` form (and therefore the marker below). Only manifests whose
every edge is a non-translation matrix — and which share nothing — stay
byte-identical to the fully-inline form.

## Failure modes, by consumer

- **Server rollback** (the one-way door): a workspace document persisted by a
  compact-aware binary fails to decode on an older binary — collection
  workspaces become unloadable with a "missing field" decode error.
  *Recovery:* re-upgrade the server, or (destructively) remove the affected
  dataset from the workspace and re-open it under the old binary.
- **Version-skew window, loud**: a stale cached web bundle or an older CLI
  talking to an upgraded server fails visibly on collection payloads (decode
  error on the broadcast/snapshot). Hard refresh the web client / upgrade the
  CLI.
- **Version-skew window, silent**: an older Python client does not crash — it
  reads per-image fields defensively and simply finds no `multiscale`, so
  dataset summaries come back **empty/degraded with no error**. This is the
  sneakiest mode; there is nothing to alert on client-side.

This skew exposure is deliberate and bounded: lucida ships as a single
container image in which server, web bundle, and WASM are versioned together
([Single-Image Container with `ServeDir`](../decisions/0020-single-image-with-servedir.md)),
so a skew window exists only for cached bundles, external CLI installs, and
Python environments, and closes on upgrade.

## Auto-migration of persisted documents

Fully-inline documents written before the compact form keep decoding forever
(the decoder accepts both forms). But the encoder has no inline mode, so a
legacy document **re-persists in the compact form after its first write**
under a compact-aware binary. Merely reading does not rewrite; any
document-mutating action does. After that write, the rollback door above is
shut for that document too.

## The `format_version` marker

Whenever a compact construct is present, the manifest and the proxied fetch
descriptor lead with `"format_version": 2`
(`COMPACT_MANIFEST_FORMAT_VERSION` in `lucida-content/src/graph.rs`,
`COMPACT_FETCH_FORMAT_VERSION` in `lucida-protocol/src/fetch.rs`). Absence
means the document is fully-inline and readable by every decoder generation.
Consumers today ignore the marker — it carries no reference-resolution
semantics — but future readers can use it to recognize a document's format
generation up front instead of probing for compact fields. Keep it that way:
the marker is a label, not a dispatch mechanism.

## What to do when touching this encoding

- Never add an encoder mode that re-inlines shared values "for
  compatibility" — that reopens the size blowup the compact form exists to
  prevent and forks the canonical form.
- Any future compact construct must bump the relevant `format_version`
  constant and extend this page's skew table.
- The byte-level shape is locked by the wire goldens
  (`lucida-server/tests/wire_goldens.rs`, `dataset_opened_collection.json`);
  a change that regenerates fixtures is a compatibility event — say so in the
  commit body so it reaches the release notes.

## Related

- [Single-Image Container with `ServeDir`](../decisions/0020-single-image-with-servedir.md) — why in-image skew cannot happen
- [Scene/DocumentState JSON Backward Compatibility](scene-document-state-json-compat.md) — the adjacent old-payload compatibility discipline
