---
type: Flow
title: "Flow: Saved-View Recipient Apply"
description: "The path a #view=<inline> or #b=<id> URL takes from \"user clicks a shared link\" to \"view matches sender's snapshot, controls work on the right dataset, URL reflects the live state.\""
tags: [lucida, flow]
source_path: wiki/flows/saved-view-recipient-apply.md
created: 2026-05-08
modified: 2026-07-16
---

# Flow: Saved-View Recipient Apply

The path a `#view=<inline>` or `#b=<id>` URL takes from "user clicks a shared link" to "view matches sender's snapshot, controls work on the right dataset, URL reflects the live state."

## Trace (cold tab, `#view=<inline>` URL)

1. **Browser navigates** to `https://lucida.example.com/#view=<base64gz>`. React mounts.
2. **Auth gate** — middleware extracts `AuthPrincipal` from the `lucida_session` cookie. If unauthed, `UnauthLanding` HTML is served; the JS shim captures `location.hash`, POSTs to `/auth/start` (preserving the hash), Google round-trip, callback restores the original URL with hash intact, React mounts. See [Flow: Authentication Sign-In](auth-signin.md).
3. **`useSavedViewSync` mounts** (`lucida-web/src/hooks/useSavedViewSync.ts`). Constructs the applier and `urlSync` engines.
4. **`urlSync` bootstrap** (`lucida-web/src/savedView/urlSync.ts`):
   - Reads `window.location.hash`. Matches `#view=…` regex.
   - Calls `decoder.decode(payload)`: base64url-unwrap → ungzip via `DecompressionStream` → `JSON.parse`. The decoder requires `v > 0`; any `v` above the current version decodes best-effort with a console warning (never refuses).
   - Sets `applyInProgress = true`. Hands the decoded `SavedView` to the applier.
5. **Applier diffs datasets** (`lucida-web/src/savedView/applier.ts`):
   - For each URL in `view.datasets`, compute `DatasetId` via the injected `dataset_id_for_url` (BLAKE3 prefix; see [lucida-core](../systems/crates/lucida-core.md)).
   - Compare against currently-loaded scene `dataset_ids()`.
   - Build "missing" set (in link, not loaded).
6. **Applier opens missing datasets**:
   - For each missing URL, call `bridge.sendOpenRemoteDataset(url)` (a [document command](document-command-application.md)).
   - Server processes the open via the existing [dataset opening flow](dataset-opening.md), broadcasts `DatasetOpened` (sentinel `sender = u64::MAX`, so the requester gets a `CommandBroadcast`, not an `Ack`).
   - Applier subscribes via `useBridge`'s `savedViewHooksRef` to `DatasetOpened`/`OpenDatasetFailed` and resolves a per-URL promise.
   - **Loading banner** (`LoadingViewBanner`) reads applier state and shows progress: "Loading shared view: 2 of 4 datasets…"
7. **Applier applies in fixed order** once all opens have resolved (success or failure):
   - **Visibility-only-for-recipient**: any currently-loaded dataset NOT in `view.datasets` gets `SetDatasetVisible(false)` (a viewport command — applies to recipient only; peers unaffected).
   - **Layouts** (document commands): `SetActiveLayout` for each entry in `view.active_layouts` where the link's layout differs from current. Missing layout → fall back to dataset's default + `console.warn`.
   - **Per-dataset settings** (viewport commands): `SetDatasetOrder`, then per-dataset `SetDatasetVisible` / `SetDatasetOpacity` / contrast / gamma / blend / render mode / per-channel colormap+contrast+gamma.
   - **Global display** (viewport commands): `SetContrast`, `SetGamma`, `SetMultiChannel`.
   - **View dimensions** (viewport commands): `SetT`, `SetC`, `SetZRange`. Out-of-range t/c/z clamp to the recipient's dataset extents (`clampViewIndices`); when any axis moves, a non-blocking "adjusted to fit" notice naming the moved axes (e.g. "Z and C adjusted to fit this dataset") is surfaced via `clampNotice` → `addWarning` — the clamp is no longer silent (see [Saved Views](../systems/subsystems/saved-views.md)).
   - **Camera last** so the user doesn't see the camera yanking around mid-load.
8. **Apply-result emission**: applier calls `emitApplyResult({ visibleDatasetIds, firstVisible })`. `useSavedViewSync` forwards via `onApplyResult` → `App.tsx::handleApplyResult` calls `setSelectedDatasetId(firstVisible)` so side-panel controls point at a visible dataset (see [Saved Views](../systems/subsystems/saved-views.md) §"selectedDatasetId wrinkle").
8b. **Apply-complete emission**: applier calls `subscribeApplyComplete(view)` listeners. `useSavedViewSync` uses this channel to (a) `markInteractiveDirty` + `markResidencyDirty` so the RAF loop redraws (otherwise the view doesn't refresh until next user input — bug 2), (b) push C/T/Z/viewMode back to React state from post-apply WASM state (otherwise the dim sliders show stale values — bug 3), and (c) restore client-only preferences from the applied view (e.g. `auto_contrast` — otherwise recipient's defaults silently overwrite captured values; see [SavedView Mirrors WASM Presence — Client-Only State Won't Round-Trip Without a Dedicated Field](../gotchas/saved-view-client-only-state.md)).
9. **`applyInProgress = false`.** `urlSync` resumes normal write path.
10. **Failure surfacing**: any `OpenDatasetFailed` is folded into the loading banner state ("Loaded 3 of 4 datasets (1 failed: …)"). Other datasets apply normally — partial-apply policy.

## Trace differences for `#b=<id>` URLs

Steps 1-3 unchanged. Differences:

4. **`urlSync` bootstrap** matches the `#b=…` regex via `parseSavedViewIdHash` (validator: `[A-Za-z0-9._-]+`). The legacy hash key is retained for link stability, but it denotes a workspace saved-view id rather than the retired global bookmark store.
5. **Resolve the workspace saved view** through the injected `fetchSavedViewById` callback. Production `App.tsx` binds it to `getWorkspaceSavedView(workspaceId, id)`, so the workspace path supplies the authorization boundary. Missing/inaccessible rows reject or return `null`; urlSync warns and leaves the hash unchanged.
6. **Apply** the returned `view` payload via the same applier path (steps 5-9 above).
7. **URL collapse** (`urlSync.ts`): after successful apply, `replaceState` to `#view=<inline>` (encoded from the just-applied `SavedView`). Further pans advance the URL from that snapshot; the tab is not live-bound to later edits of the stored row.

## Apply order matters

The fixed order in step 7 is load-bearing:

- **Layouts before per-dataset settings** because per-channel settings reference channel indices that depend on the active layout.
- **Per-dataset settings before global display** because some global settings (`SetMultiChannel`) interact with which channels exist per-dataset.
- **Camera last** so panning artifacts during load aren't visible.
- **Visibility-only-for-recipient first** so peers' shared datasets don't briefly flash off mid-apply.

## Why visibility is set per-dataset rather than removing datasets

Opening a saved view in an active session is **constructive on the dataset side and private on the view side**:

- Adding datasets uses `OpenRemoteDataset` (document command) — broadcasts to all session peers; everyone benefits from the loaded datasets.
- Setting `dataset_settings`, `dataset_order`, and per-dataset visibility uses viewport commands (per-client local) — only the recipient sees the captured view; peers' personal views are unaffected.

This matches the [Document vs Viewport Command Split](../decisions/0001-document-vs-viewport-split.md) discipline: shared/sequenced state goes through document commands; local/ephemeral state stays viewport-side.

## Apply / sync feedback loop is impossible by construction

`urlSync` reads `applyInProgress` from the applier and suppresses writes during apply. So:

- Applier fires `SetT(5)` → triggers a viewport-emit listener → `urlSync` sees `applyInProgress = true` → skips `replaceState`.
- Apply completes → `applyInProgress = false` → first user-driven viewport change after apply gets the normal debounce.

Without this flag, the apply path would write to the URL mid-apply, then the next bootstrap-on-popstate would re-read a partially-applied URL and re-apply — a feedback loop. The flag is the single source of truth and the only thing preventing it.

## `popstate` interaction

Browser back/forward fires `popstate`. `urlSync` re-runs the bootstrap (`#view=…` or `#b=<id>`). If `applyInProgress` is true (a previous apply hasn't finished), the popstate is ignored — no nested apply.

## Invariants

- **Apply order is fixed and load-bearing.** See above.
- **The applier's `applyInProgress` flag is the single source of truth** for "should urlSync write right now." `urlSync` and `popstate` both read it.
- **Partial failure surfaces inline; never aborts the whole apply.** A missing/inaccessible dataset shows in the loading banner; other datasets still apply. Out-of-range t/c/z indices clamp to fit (with a non-blocking "adjusted to fit" notice) rather than failing.
- **Self-state on apply ends with `selectedDatasetId` pointing at a visible dataset.** Maintained by `emitApplyResult`'s `firstVisible` selection. Applies even when the recipient already had a different dataset selected before opening the link.

## Gotchas

- **`v > 1` is best-effort, not refused.** A stale tab opening a fresh link should degrade, not break. The decoder applies known fields and console-warns; the user sees something, even if not everything.
- **`OpenDatasetFailed` for one URL doesn't abort the whole apply.** Other datasets apply; the failed one shows in the banner. Local-file paths often surface here when the recipient is on a different server (see [Saved Views](../systems/subsystems/saved-views.md) §"Local-file dataset sharp edge").
- **Layout fallback is silent in the UI** — only console-warned. If a sender shares a link with a custom layout that the recipient's dataset version doesn't have, the recipient sees the dataset's default layout with no toast. Acceptable tradeoff (toasting on every layout fallback would be noisy for small dataset-shape drift).
- **Auto-select picks the first *visible* dataset in `dataset_order`**, not the first in the array. If everything is invisible, picks the first dataset. Tests cover both branches.

## Related

- [Saved Views](../systems/subsystems/saved-views.md) — subsystem overview + invariants
- [URL-as-App-State for Saved Views](../decisions/0013-url-as-app-state-for-saved-views.md) — Y-model rationale
- [Server-Stored Bookmarks and the AuthPrincipal Seam](../decisions/0015-server-stored-bookmarks-and-auth-seam.md) — historical predecessor and auth-seam rationale
- [Sunset dispositions for the three superseded server surfaces](../decisions/0043-superseded-server-surfaces-sunset.md) — redefines `#b=<id>` as a workspace saved-view address
- [Flow: Document Command Application](document-command-application.md) — `OpenRemoteDataset` is a document command
- [Flow: Dataset Opening](dataset-opening.md) — the open path each missing dataset takes
- [Flow: Authentication Sign-In](auth-signin.md) — hash preservation through OAuth
- [Saved-View URLs Expose Dataset URLs (and Anything in Them)](../gotchas/saved-view-credentials-in-urls.md) — URL-exposure footgun for credentialed URLs
