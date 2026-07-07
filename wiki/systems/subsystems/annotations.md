---
type: Subsystem
title: "Annotations, comments, and mentions"
description: "A collaborative markup layer over a dataset: point/line/box pins, a flat"
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/annotations.md
created: 2026-06-25
modified: 2026-07-06
---

# Annotations, comments, and mentions

A collaborative markup layer over a dataset: point/line/box **pins**, a flat
**comment thread** per pin, and inline `@mention` text in comments. It spans all
three tiers — authoritative state in `lucida-core`, persistence/broadcast in
`lucida-server`, and the overlays/inbox in `lucida-web` — and is the richest
collaboration feature beyond [presence/follow](presence-and-follow-mode.md).

## Authoritative model (lucida-core)

`Annotation` and `Comment` live in `scene/types.rs`, nested in
`DocumentState.annotations` (keyed by dataset id). A pin carries an in-plane
world `position [x,y]`, an additive `z` depth, discrete view selectors `t`/`c`,
an `AnnotationKind` (Point/Line/Box), an optional second vertex `end` (line
endpoint / box corner), its insertion-ordered `comments`, an optional collection
`anchor` entity, and an optional captured `view` (a [SavedView](saved-views.md)).
Every field added after slice 1 is `#[serde(default)]`, so old persisted/wire
documents deserialize unchanged and a pin serializes identically whether or not
it predates a field — the load-bearing wire-compat invariant (see
[Scene/DocumentState JSON Backward Compatibility](../../gotchas/scene-document-state-json-compat.md)).

Mutations are six `DocumentCommand` variants — `AddAnnotation`,
`RemoveAnnotation`, `MoveAnnotation`, `AddComment`, `RemoveComment`,
`EditComment` (`command.rs`). All ids are **client-minted UUIDs**, so an inbound
command and its rebroadcast are byte-identical and apply identically on every
peer; apply is idempotent / last-write-wins. A comment on a missing pin is a
clean no-op (never mints a phantom pin); removing a pin cascades its thread.

### The annotation epoch

All six commands bump one counter, `epochs.annotation` (`epoch.rs`) — a pin's
thread is part of its annotation state, so comment edits invalidate the same
epoch as the pin itself. See [Scene State and Epochs](scene-state-and-epochs.md) for the full epoch model.

### Anchoring and re-anchoring on layout switch

Pins are anchored in **world space** (the same frame as `centroidWorld` /
layout positions, per ADR-0030), so they stay glued to the data for every peer
regardless of viewport. On a collection dataset, `AddAnnotation`'s apply additionally
glues the pin to the nearest placeable group/tile (`nearest_anchor`) — computed
inside the canonical apply from synced state, so server and clients derive the
**same** anchor without it riding the wire. When the active layout changes,
`reanchor_for_layout` rigidly translates each anchored pin (position + `end`) by
its anchor entity's displacement between layouts, keeping it on the data it was
dropped on across every [layout](layout-system.md). `z` is never touched (layouts
are 2-D in-plane); an unanchored pin, or one whose anchor isn't placed in *both*
layouts, is left alone (no phantom origin jump).

### 3D projection

`project_annotation` lifts a pin's voxel point to arcball world via the **same**
`rendering_transform` the volume pass uses, then projects with the active camera
(2D mode keeps the plain in-plane projection). `pick_annotation_voxel` is its
exact inverse (ray-cast → voxel), so a 3D-dropped pin re-projects under the
cursor; a ray miss declines the drop (a pin must anchor to data, never float).
`annotation_world_point_for` backs the `CenterOnVoxel3D` "jump to a pin"
viewport command, sharing one world-point definition with the marker projection.

## Persistence and broadcast (lucida-server)

Annotations ride the existing document machinery for free: applied commands go
through `persist_applied_command` → `persist_document` (full `DocumentState`
JSON) and rebroadcast to peers, **excluding the sender** (the author's own view
already updated via the local apply). The mutating client supplies the id so the
local apply and peers' broadcast converge.

Two security invariants are enforced server-/core-side, not by the UI:

- **Strip embedded source URLs.** A pin's captured `view` is stored in
  workspace-dataset-id form (empty `datasets`). `AddAnnotation`'s apply calls
  `clear_source_urls()` on **every** applied pin, so even a malformed/hostile
  command can't smuggle source URLs (incl. local `file:///`) into
  broadcast/persisted state (decision 0014). The id-keyed fields the restore
  path reads are untouched.
- **Never-leak.** A `/w/<id>` deep-link is openable by anyone, so a workspace a
  recipient can't access returns a uniform `NotFound` — byte-identical to a
  missing one — mirroring the saved-views never-leak discipline.

Dataset **duplication** remaps a copied pin's embedded `view` onto the copy's
dataset ids across every id-keyed field, so a copied pin's "go to author's view"
never dangles back to the source. See [Workspaces](workspaces.md).

## Web surface (lucida-web)

Two overlays — `AnnotationOverlay` (2D slice) and `AnnotationOverlay3D` (volume)
— re-project markers from world space **every animation frame** (like peer
cursors), reading authoritative state via `scene.annotations(datasetId)` and
never holding a parallel copy; a `version` bump (the remote-document version)
re-reads the set. Both render the **one** shared `ThreadPopover` (comment
list/add/edit/remove + two-step pin delete + `@`-mention picker + "Copy link" +
"Go to author's view"), so the thread is identical in 2D and 3D.
`AnnotationDraftOverlay` previews a box/line **screen-space** while it's drawn.

The overlay components keep only their genuinely dimensional differences
(marker projection, pan-vs-orbit gestures, `focusPin` recenter mechanics, the
2D-only hover-revealed reshape handles); everything view-independent lives in
shared non-component modules both import: `annotationDocument` (the pin/comment
model + the one tolerant `readAnnotations`), `useAnnotationOverlay` (pin-set
re-read on version/dataset change; the open thread's close-on-vanish /
close-on-dataset-change / close-on-hide lifecycle), `annotationInteraction`
(the ONE `PIN_CLICK_SLOP` click-vs-drag threshold + tolerant pointer-capture
helpers + `emitMoveAnnotation`, the single `move_annotation` construction site
— its field presence/values are locked by the wire goldens, which compare
parsed frames; key order is serde-irrelevant), `cameraProjection` (the
event↔world↔screen conversions `SliceViewer`/`VolumeViewer`/`PeerCursors` share
too), and `AnnotationPinBadges` (the comment-count pill and off-context locator
— both views render both, so a pin reads identically in 2D and 3D).

- **Author identity** comes from `annotationIdentity` — a `localStorage`-persisted
  id, *not* the per-connection `bridge.myId` — so author-only affordances
  (move/delete pin, edit/remove own comment) survive leaving and rejoining a
  workspace. Authorship is UI-enforced only; the server applies commands without
  an author check.
- **Mentions** are just inline `@handle` text in `Comment.text`
  (`annotationMentions` defines the one token grammar; `annotationParticipants`
  derives candidates + the deterministic `deriveHandle`) — **no** new wire
  command. `MentionsOfMe` is a pure per-dataset inbox; `useViewedMentions`
  persists read-state per browser/dataset in `localStorage`.
- **Off-context indication** (`annotationContext`): a pin whose own z/t/c differ
  from the current view renders dimmed with a "where it lives" helptext, like an
  off-view peer cursor — a pure function of `(pin vs viewContext)`, so navigating
  to its slice flips it back automatically. 3D ignores Z (the volume renders all
  slices); only T/C dim a pin there.

### Author-view capture/restore and the `#a=` deep-link

On create, `buildAnnotationView` snapshots the author's live view onto the pin
(workspace-dataset-id form). On demand — a thread's "Go to author's view", a
mention jump, or a deep-link — `restoreAnnotationView` runs the **LIGHT** restore
tier: recipient-local viewport/display commands only (camera mode, z/t/c, global
+ per-channel display), clamped to the pin's own dataset extents. It deliberately
**never** opens/hides datasets, broadcasts a layout, or calls `sendCommand` — the
heavy [SavedView](saved-views.md) applier does that for cold share-link opens, and
doing it for an in-session jump would be destructive. The boundary is enforced by
construction (the destructive commands have no call site there).

`ThreadPopover`'s "Copy link" yields `<workspace-url>#a=<pinId>` — a deep-link,
**not** an access grant (the recipient still loads the workspace through the
existing gate). `useAnnotationDeepLink` resolves it keyed on the document
version, **after** the snapshot loads (resolving at scene-bootstrap would search
an empty document — the #802 class), fires once per link id, and surfaces a plain
"couldn't be found" for a missing/forged id (same outcome as not-authorized — no
existence leak).

## Gotchas

- The marker RAF tick must **skip** reprojecting a pin mid-move (the pointer
  handler positions it) but **keep** reprojecting during a pan/orbit — otherwise
  the dot fights the drag or freezes against the camera.
- A 3D Shift-drag move repositions a pin **in-plane only**, preserving its own
  `z` rather than the picked voxel depth (#791) — else a drag silently re-slices
  the pin off-context.
- `restoreAnnotationView` skips the extent clamp when the pin's dataset can't be
  resolved (the inbox/null-selection window), or the captured z/t/c collapse
  against the WASM `[1,1,1]` sentinel `dataset_volume_shape("")` returns (#814).
