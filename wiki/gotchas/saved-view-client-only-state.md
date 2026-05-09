---
created: 2026-05-09
modified: 2026-05-09
---

# SavedView Mirrors WASM Presence — Client-Only State Won't Round-Trip Without a Dedicated Field

## The footgun

`SavedView.dataset_settings` mirrors `Scene::dataset_settings` (the WASM-side struct exported via `scene.export_dataset_presence()`). Anything stored *outside* that struct — in JS-only React state, in localStorage, in the GPU worker — is invisible to capture and silently lost on apply.

The classic trap: a JS-side flag that *modifies how the WASM-side values are interpreted or overwritten*. The recipient's default value for that flag overrides whatever the captured WASM values say.

**Concrete example** (PR #484): `useDatasetSettings.autoContrastMap` is a `Map<datasetId, boolean>` defaulting to `true`. The intensity batcher (`useIntensityBatcher.ts`) reads it and *overwrites* the WASM-side contrast min/max with auto-computed values whenever the flag is `true`. SavedView captures the WASM contrast values correctly. Recipient applies them. Recipient's `autoContrastMap` defaults to `true` for every dataset. Intensity batcher fires on first chunk arrival. Captured values are clobbered. Sender sees one thing, recipient sees another.

## How to detect it

When adding any new "preference" or "mode" in JS-side hook state, ask:
1. Does anything downstream read this and *mutate* WASM-side state based on it? (auto-contrast → contrast values; future "auto-zoom" → camera; etc.)
2. Does the WASM-side state mirror through `export_presence` or `export_dataset_presence`?
3. If yes to both: the JS preference must round-trip in SavedView, or recipients silently override with their defaults.

A quick sanity test: capture a SavedView, decode it back, apply, and check whether every visible characteristic of the sender's view is reproduced. Not just "does the WASM state match" — that's necessary but not sufficient.

## Fix pattern

Add a dedicated, optional, defaults-stripped field to `SavedView`. Don't pollute `dataset_settings` (which mirrors a real WASM struct). Concretely:

1. **Rust** (`lucida-core/src/saved_view.rs`): add the field with `#[serde(default, skip_serializing_if = "...")]`.
2. **TS types** (`lucida-web/src/savedView/types.ts`): add the optional field.
3. **WASM rebuild**: `npm run build:wasm`.
4. **Capture** (`captureBuilder.ts`): read the React state ref and emit per-dataset entries.
5. **Encoder** (`encoder.ts`): strip default values so wire payload only carries deviations.
6. **Apply** (`applier.ts` + `useSavedViewSync.ts`): the `subscribeApplyComplete` channel now passes the applied `SavedView` so listeners can restore client-only state. Add a `setX` setter to `Params` and call it from the listener.

`auto_contrast` (PR #484) is the canonical worked example.

## Why we don't just shove client state into the WASM scene

Adding `auto_contrast` (or any other JS-only preference) to the WASM scene would:
- Pollute the wire protocol with values that have no meaning to non-web clients (CLI, Python).
- Force every WASM consumer to know about web-specific UX state.
- Bloat `PresenceState` and the document/viewport split.

The seam is correct: WASM owns truth about pixels; JS owns truth about UX preferences. SavedView spans both, and gets a separate field per JS-only preference rather than expanding the WASM types.

## Where this could bite again

Anything currently stored in `useState`/`useRef` in `useDatasetSettings`, `useDimensions`, `useLayout`, etc., that influences how WASM state gets rewritten:

- Auto-anything (auto-zoom-on-dataset-open, auto-fit-camera, auto-LOD)
- Per-dataset toolbar modes
- Locked/pinned channels in multi-channel mode (if "lock" is JS-side and prevents updates)
- Future "stick" settings (e.g. "keep contrast when switching channels")

When adding any such preference, decide upfront whether it needs to round-trip — if yes, add a SavedView field at the same time, with capture + apply wiring.

## Related

- [[decisions/0013-url-as-app-state-for-saved-views]] — the SavedView wire format and `v` discipline
- [[saved-views]] — subsystem that owns the SavedView round-trip
- [[flows/saved-view-recipient-apply]] — where the apply-complete listener restores client state
- `lucida-web/src/savedView/captureBuilder.ts` + `useSavedViewSync.ts` — the canonical wiring pattern
