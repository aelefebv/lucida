---
created: 2026-06-25
modified: 2026-06-25
---

# Flow: Annotation Lifecycle

From "a user shift-drags a pin onto a dataset" through "the author's exact view is captured onto the pin, broadcast, and persisted" to "anyone restores that view — by clicking the pin's thread, following an @mention, or opening a `#a=<id>` share link." This is the one path that ties annotations to the [[saved-views]] capture machinery and the [[document-command-application|document-command]] flow. The annotations subsystem otherwise has no wiki home.

The defining tension: a pin carries a full [[saved-views|SavedView]] (camera + slice/timepoint/channel + per-dataset display), but restoring it must NOT be the heavy cold-share-link apply — it must be a **light, recipient-local** restore that never disturbs the workspace. That split is the heart of this flow.

## Trace: create

1. **Gesture** — a shift-drag on the slice canvas. `SliceViewer.tsx::onPointerUp` (~`:218`) constructs the pin: `position`/`end` from the released world point(s), `z`/`t`/`c` from the live slider refs (so the pin belongs to the slice/timepoint/channel it was dropped on, issue #779), `author` from `annotationIdentity.ts::annotationAuthorId()`.
2. **Capture the author's view** — `buildAnnotationView(scene, liveViewWithLiveZTC(...))` (`buildAnnotationView.ts`) snapshots how the author is looking right now. It is a thin policy seam over `captureBuilder.ts::buildCapture` pinning two choices: `datasetReferenceMode: "workspace-dataset-id"` (so the view's `datasets` Vec is left EMPTY — no source URLs ever land on the pin), and verbatim live Z/T/C (the 2D path preserves the presence slab thickness + `multi_channel`; the 3D path uses `liveViewWithLiveTC`, taking presence z but overriding t/c). Capture failure returns `null` and is simply omitted — the view is additive.
3. **Apply locally AND send** — `applyDocumentCommand(scene, { type: "add_annotation", … view }, sendCommand)`. This is a [[document-command-application|document command]]: optimistic local apply + send; the client-supplied UUID `id` makes the local apply and the server's rebroadcast converge. The captured view rides on the command only when present (`...(capturedView ? { view } : {})`).
4. **Canonical apply** — `lucida-core/src/command.rs` `AddAnnotation` arm (`:111`): unbox the view (`Option<Box<SavedView>>` on the wire, kept boxed to dodge clippy's `large_enum_variant`; stored unboxed on `Annotation::view`). `DocumentState::apply` also glues the pin to the nearest placeable layout entity via `nearest_anchor` (`scene/types.rs:853`), storing `Annotation::anchor` (issue #780). The arm bumps `epochs.annotation` (`command.rs:534`) — shared by every annotation/comment command.
5. **Render** — the annotation-epoch bump drives the overlay redraw on the next tick (see [[scene-state-and-epochs]]).

## Trace: restore (in-session, the light tier)

Triggered explicitly: a pin thread's "Go to author's view" (`App.tsx::handleGoToAuthorView`), an @mention jump (`handleNavigateToMention`, issue #526), or the deep-link below. All route to `App.tsx::restoreCapturedView`, which calls `restoreAnnotationView.ts::restoreAnnotationView` in this fixed order:

1. **Camera MODE first** — `switchCameraMode` flips the scene 2D↔3D to match the captured camera (`set_mode_slice`/`_arcball`/`_fly`), BEFORE the camera shape is imported. A `fly` capture stays `fly` (no silent arcball downgrade).
2. **Display** — global `set_contrast`/`set_gamma` (+ `set_multi_channel` when captured), then per-dataset/per-channel display (colormap/contrast/gamma) for the LOADED captured datasets, pin's own dataset first. Replayed via the shared `applier.ts::datasetDisplayCommands`, which by construction EXCLUDE visibility/opacity/order — display fidelity for multi-channel data without touching layout.
3. **z/t/c** — clamped to the **pin's own dataset** extents (a minimal single-dataset view scopes the clamp), with a non-blocking "adjusted to fit" notice when an axis moves.
4. **Camera shape last** — via `import_presence` (read live presence, overwrite only the camera, write back) so the camera lands atomically; a malformed captured camera is caught and skipped, leaving the rest applied.

`restoreCapturedView` then mirrors the applied indices/mode back into React state, breaks follow, emits presence, and `focusPinForMode` recenters on the pin (deferred one frame when the camera mode flipped, so the correct overlay has mounted). A pin with no captured view degrades to `gentleOnContext` (today's z/t/c-only recenter — no regression).

## Trace: `#a=` deep-link

The link is the workspace URL + `#a=<annotationId>` — a deep-link, NOT an access grant (no token, widens nothing). Built by `urlSync.ts::buildAnnotationLink`; the id is matched against the conservative `[A-Za-z0-9._-]+` class in `parseAnnotationHash` (`urlSync.ts:412`).

1. **Bootstrap recognizes, defers** — `urlSync.ts::bootstrap` (`:168`) sees a `#a=` hash and returns WITHOUT applying anything, so the default/last-view never overwrites the link target. Resolution is the host's job, post-doc-load.
2. **Resolve once the doc loads** — `useAnnotationDeepLink.ts` re-runs on every `remoteDocumentVersion` bump (the post-doc-load signal). `annotationDeepLink.ts::resolveAnnotationDeepLink` scans every annotated dataset (`annotation_dataset_ids()` / `annotations(id)`) for the id. Resolving at scene-bootstrap instead would search an empty document and focus an unloaded pin (the #802 class), which is exactly why this is a version-keyed hook, not a line in bootstrap.
3. **Restore + focus** — `restoreAnnotationDeepLinkPin` selects the pin's dataset (it may not be the selected one), defers a frame so the overlay mounts, then runs the light restore above with the pin's dataset passed explicitly.
4. **Collapse the hash** — AFTER the restore applies, `savedViewSync.collapseDeepLinkHash` rewrites `#a=` → live `#view=` (the same tail `#b=` runs). Collapsing earlier would snapshot the pre-restore camera; staying on `#a=` would re-yank the camera on every popstate.

## Invariants

- **A pin's view never carries source URLs.** Always workspace-dataset-id form (empty `datasets`) — membership is the workspace document's job; an embedded view must not leak URLs onto broadcast/persisted state.
- **A command WITH a view rebroadcasts byte-identically.** The server's `from_str`→`to_string` round-trip is exact because [[saved-views|SavedView]]'s per-dataset maps are `IndexMap` (order-preserving), not `HashMap`. Locked by `add_annotation_with_multi_dataset_view_rebroadcasts_byte_identical`.
- **The light restore issues ONLY recipient-local ViewportCommands.** No `sendCommand`, no `set_dataset_visible`/`_opacity`/`_active_layout`/`_order`, no dataset open — the boundary is enforced by the destructive commands having no call site in `restoreAnnotationView.ts`.
- **Annotation access == workspace access.** A recipient without workspace access fails at the gate; an id absent from the loaded doc returns plain `not-found` — indistinguishable, by construction, from "exists but you can't see it."
- **Author identity outlives a connection.** `annotationAuthorId()` is a localStorage UUID cached in-memory for the session — NOT `bridge.myId` (which the server reassigns per WS connect). Rejoining keeps ownership of your pins (issue #777).

## Gotchas

- **The `[1,1,1]` clamp trap (#814).** Clamping z/t/c against `dataset_volume_shape("")` returns the WASM `[1,1,1]` sentinel, collapsing a deep captured Z to plane 0. When the pin's dataset can't be resolved (the null-selection / Mentions-inbox window), `restoreAnnotationView` SKIPS the clamp and passes the captured z/t/c through unchanged.
- **`not-found` does not mark the link handled.** A pin created live by a peer in a later doc bump still resolves and clears the notice; only a successful restore is once-per-link.
- **Additive wire fields throughout.** `z`/`t`/`c`/`end`/`kind`/`view`/`anchor` are all `#[serde(default)]` — a slice-1/2 pin (or replayed older log entry) deserializes as a plain point at `z=0, t=0, c=0`, view `None`, anchor `None`.
- **Anchored pins ride layout switches.** When the active layout changes, `reanchor_for_layout` (`scene/types.rs:905`) rigidly translates each glued pin by its anchor entity's displacement, in the canonical apply path — so it persists and reaches every peer identically (issue #780).

## Related

- [[saved-views]] — the capture/`SavedView` type a pin embeds and the heavy applier this path deliberately avoids
- [[saved-view-recipient-apply]] — the HEAVY cold-share-link tier (opens/hides datasets); the contrast to this light path
- [[document-command-application]] — `AddAnnotation`/comment/move commands and the optimistic-apply + byte-identical-rebroadcast model
- [[scene-state-and-epochs]] — `epochs.annotation` and the redraw it drives
- [[layout-system]] — the placed-entity model `nearest_anchor`/`reanchor_for_layout` depend on
- [[presence-and-follow-mode]] — restore breaks follow and re-emits presence; `bridge.myId` vs the author id
