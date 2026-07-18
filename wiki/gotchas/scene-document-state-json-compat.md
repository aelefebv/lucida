---
type: Gotcha
title: "Scene/DocumentState JSON Backward Compatibility"
description: "Scene composes DocumentState with #[serde(flatten)] so that the on-the-wire JSON shape stayed compatible across the Document-state refactor."
tags: [lucida, gotcha]
source_path: wiki/gotchas/scene-document-state-json-compat.md
created: 2026-04-18
modified: 2026-07-16
---

# Scene/DocumentState JSON Backward Compatibility

## The footgun

`Scene` composes `DocumentState` with `#[serde(flatten)]` so that the on-the-wire JSON shape stayed compatible across the Document-state refactor. This means **adding a field to one without considering the other can corrupt the wire format**.

A new `Scene`-only field accidentally serialized at the same level as `DocumentState` fields will collide with future `DocumentState` additions; a new `DocumentState` field that overlaps with a `Scene` presence field can't be distinguished on deserialize.

## What flatten does

`#[serde(flatten)]` causes the nested struct's fields to appear at the parent's level in JSON, rather than under a key. `Scene` carries `document: DocumentState` annotated with `#[serde(flatten)]`, so the JSON encoding has both Scene fields and DocumentState fields at the same top level. Older clients deserializing the same JSON into the previous (un-flattened) Scene shape still work because the field names match.

## The compatibility tests

Backward-compat tests live across `scene/mod.rs`, `scene/types.rs`, and `command.rs`, covering:

- Old JSON without new fields deserializes (defaults applied via `#[serde(default)]`). The scene-module example is `scene_backward_compat_deserialization_without_settings` (`scene/mod.rs`).
- New JSON with all fields round-trips through old struct shapes (e.g. the `pin_without_view_*` tests in `scene/types.rs`).
- Specific backward-compat cases like `dataset_display_settings_backward_compat` (no `channel_settings`, no `channel_blend_mode` in old payloads) — that one lives in `command.rs`, not the scene module.

When you add a field, **add a backward-compat test** that deserializes a literal JSON string from the old shape. Without it, drift is invisible until a snapshot from an old client breaks.

## Persisted workspace envelope

The server's durable `workspaces.document_json` column has its own version boundary. Historical rows are an implicit v0 bare `DocumentState`; current writes use a v1 envelope:

```json
{"format_version":1,"document":{"manifests":{}}}
```

Reading a valid v0 row remains supported, and the next successful document write migrates it to the v1 envelope. A row with an explicit unknown version fails closed with a typed error and is never reinterpreted as v0 or rewritten. The marker must be an unsigned 32-bit integer. This envelope is a server-private persistence format; it does not change the flattened client snapshot shape described above.

## What to do

- **New `Scene`-only fields**: ensure the field name doesn't collide with anything in `DocumentState`. Default it via `#[serde(default)]` if it's not always present.
- **New `DocumentState` fields**: same — `#[serde(default)]` and a literal-JSON backward-compat test.
- **Don't remove `#[serde(flatten)]`**. It's load-bearing for snapshot compatibility across the Document-state split.
- **Don't rename existing fields** without a deserialization migration.
- **When persisted state changes incompatibly**, bump the workspace document format and add explicit migration fixtures. Never make an unknown explicit version fall back to the legacy bare shape.

## Why we keep it

The alternative — bumping the wire format and migrating all snapshots — would force every client to upgrade in lockstep. The flatten approach lets old clients survive a Scene refactor without seeing the change.

## Related

- [lucida-core](../systems/crates/lucida-core.md)
- [Scene State and Epochs](../systems/subsystems/scene-state-and-epochs.md)
