---
created: 2026-05-08
modified: 2026-06-25
---

# Saved Views

Cross-cutting subsystem spanning [[lucida-core]] (the `SavedView` schema), [[lucida-web]] (encoder, applier, URL sync, sidebar UI), and [[lucida-server]] (SQLite-backed bookmark/workspace saved-view stores, REST API, broadcast). Provides three surfaces over one capture record:

1. **Live URL** (`#view=…`) — debounced `window.history.replaceState` keeps the URL hash a current snapshot of the view. Sharing = copy URL. Refresh preserves view. No server involvement.
2. **Named bookmarks** (`#b=<id>`) — server-stored entries with name + creator + timestamp; visible in a sidebar filtered to bookmarks for currently-loaded datasets; live cross-peer updates via `BookmarkChanged` broadcast.
3. **Workspace saved views** — workspace-scoped named entries under `/api/workspaces/:workspace_id/saved-views`. Editors can create/update/rename/delete and set/clear the workspace default view; viewers can list/open/copy. Payloads use workspace-local dataset ids and intentionally omit source URLs.

## Why two surfaces, one record

The capture record (`SavedView`) is the same shape both ways. A `#b=<id>` opens by fetching the row, handing `view` to the same applier the `#view=…` path uses, then `replaceState`-ing the URL to `#view=…` so further pans don't drift back to the snapshot. Adding the bookmark side didn't fragment the design — it added an addressable artifact whose payload is a `SavedView`, identical to what the inline-encoded URL carries.

Full design rationale in [[decisions/0013-url-as-app-state-for-saved-views]] (the Y-model choice over encode-on-demand) and [[decisions/0015-server-stored-bookmarks-and-auth-seam]] (why server-stored, why SQLite, why the `AuthPrincipal` seam).

## The capture record

`SavedView` lives in [[lucida-core]] (`saved_view.rs`) so both web (encode/decode/apply) and server (validate/store) reference the same schema. Fields mirror what's in [[presence-and-follow-mode|`PresenceState`]] for the per-client surface plus `datasets` and `active_layouts` for the document-state surface:

- `v: 1` — schema version. Decoder rejects payloads without it. `v > 1` decodes known fields with a console warning (best-effort, never refuse — refusing means a stale tab opening a fresh link breaks).
- `datasets`, `active_layouts`, `dataset_order`, `dataset_settings` — multi-dataset shape and per-dataset visibility/contrast/colormap.
- `camera`, `view`, `display` — same types as `PresenceState`.
- `auto_contrast: IndexMap<DatasetId, bool>` — JS-side preference (lives in `useDatasetSettings.autoContrastMap`, not in WASM) that round-trips explicitly so the recipient's intensity batcher doesn't immediately overwrite captured contrast values. `IndexMap` (not `HashMap`) like every per-dataset map here, so deserialize→serialize preserves key order — load-bearing for deterministic on-the-wire serialization of the collaborative document. Pattern to follow when adding new client-only state — see [[gotchas/saved-view-client-only-state]].

Notable exclusions per [[decisions/0013-url-as-app-state-for-saved-views]]: `selectedDatasetId` (UI focus only — but see "selectedDatasetId wrinkle" below), `following` (sender's follow target irrelevant to recipient), `cursor` (mouse position is noise), `client_id` (not portable).

## Three deep modules on the web side

All under `lucida-web/src/savedView/`:

- **`encoder.ts`** — pure `encode(SavedView) → string` and `decode(string) → SavedView`. Default-stripping on encode (don't emit `gamma: 1.0`, `visible: true`, etc.); restore on decode. `CompressionStream` for gzip; base64url for the URL-safe wrapper. The encoder owns the `v: 1` discipline.
- **`applier.ts`** — async orchestrator. Diffs current vs target datasets, opens missing via `bridge.sendOpenRemoteDataset`, awaits `DatasetOpened` broadcasts, then applies in fixed order: layouts → dataset_order → per-dataset settings → global display → view dimensions → camera last. Manages `applyInProgress` flag (urlSync reads to suppress writes). Surfaces `OpenDatasetFailed` to the loading-banner state. Out-of-range z/t/c clamps silently; missing layout falls back to dataset's default.
- **`urlSync.ts`** — bootstraps from `window.location.hash` on initial load (handles both `#view=…` and `#b=<id>`), subscribes to viewport/scene change events, debounces 250-500 ms idle, encodes + `replaceState`. Listens for `popstate`. Reads `applyInProgress` to break the apply/sync feedback loop.

The `subscribeApplyResult` channel on the applier is the seam for UI-state that doesn't live in the WASM scene (currently just the `selectedDatasetId` auto-select). Future capture-record fields needing similar after-apply effects should subscribe here.

## Server side: bookmarks subsystem

`lucida-server/src/bookmarks/`:

- **`store.rs`** (deep) — `BookmarkStore` trait + `SqliteBookmarkStore` + `MemoryBookmarkStore`. Two-table schema: `bookmarks` for the row + `bookmark_datasets(bookmark_id, dataset_url)` indexed for the any-overlap query. Picked side-table over JSON1 to work on every SQLite build and make `EXPLAIN QUERY PLAN` regression-guardable.
- **`handlers.rs`** — REST endpoints under `/api/bookmarks`. Permission checks at handler level: PATCH/DELETE require `bookmark.created_by == principal.email || principal.is_admin`. POST overwrites `created_by` from `AuthPrincipal` (request body cannot spoof creator).
- **`broadcast.rs`** — best-effort `BookmarkChanged` dispatch after successful CUD. Affected-client computation: check whether any session binding's `source_url` appears in the bookmark's `dataset_urls`, by URL-string equality — deliberately NOT via `dataset_id_for_url`/BLAKE3, since both ends are already the canonical source-URL string. Empty `dataset_urls` falls through as broadcast-to-all (e.g., a bookmark made before any dataset is opened).

Bookmarks are the second persistent state added to [[lucida-server]] (after auth's `login_sessions` and `pending_auth`). Same SQLite file, same connection pool.

## Server side: workspace saved views

Workspace saved views live in `lucida-server/src/workspace.rs` alongside workspace authorization and dataset membership. The `workspace_saved_views` table stores `view_json` plus name/creator timestamps, keyed by `workspace_id`; there is no dataset URL side table because source identity belongs to `workspace_datasets`.

All routes are workspace-scoped:

- `GET /api/workspaces/:workspace_id/saved-views`
- `POST /api/workspaces/:workspace_id/saved-views`
- `GET/PATCH/DELETE /api/workspaces/:workspace_id/saved-views/:saved_view_id`
- `PATCH /api/workspaces/:workspace_id/default-saved-view`

The manager enforces viewer-or-better for list/get and editor-or-better for create/update/delete/default changes. On create/update, the server clears `SavedView.datasets` before persistence; workspace saved views are expected to key `dataset_order`, `dataset_settings`, `active_layouts`, and `auto_contrast` by `workspace_dataset_id`.

`/w/:workspace_id#b=<saved_view_id>` resolves through the workspace-scoped API and collapses to `/w/:workspace_id#view=...` after a successful apply. Bare `/w/:workspace_id` applies `default_saved_view_id` when one is configured and no explicit hash is present.

## `BookmarkChanged` is unsequenced

`ServerMessage::BookmarkChanged { id, action, dataset_urls }` (in `lucida-core/src/protocol.rs`) is **unsequenced, like the presence variants** — it's a session-scoped notification, not a sequenced document command. Per [[decisions/0001-document-vs-viewport-split]] and [[decisions/0015-server-stored-bookmarks-and-auth-seam]]: bookmark mutations are durable on the server (in SQLite) but the live-update broadcast that informs other tabs is closer to presence than to a document command — there's no need for ordering, no replay-on-reconnect, and a missed broadcast just means the next dataset-loaded refetch picks up the canonical state.

The web bridge dispatcher handles it via a per-bridge `subscribeBookmarkChanged` fan-out, not the snapshot/command/ack path.

## Local-file dataset sharp edge

URLs classified as local by `lucida_content::url::is_local_dataset_url` (canonical Unix `/foo`, drive-letter `c:/foo`, UNC `//server/share/foo` — see [[decisions/0042-canonical-dataset-url-form]]; everything routes through `lucida-store::backend::open` to `LocalFileSystem`) are embedded in saved views in canonical form. `dataset_id_for_url` is BLAKE3 of the *canonical* URL string — content-derived from the string after normalization, not the file bytes. Two consequences:

- For the **sender on their own server**: refresh-preserves works as for cloud datasets (same path → same file → same `DatasetId`).
- For a **recipient on a different server**: same path may not exist, may be outside `data_dir`, or worst case may resolve to a *different* file with the same path on a different machine — silently loading the wrong dataset and applying viewport state meaningful for the original.

The `ShareToolbarButton` warns at share time when the current URL contains local-file paths. Recipients of failures get partial-apply with inline indicators. See [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] for the full rationale and the documented `DatasetId`-collision-on-different-content sharp edge.

## selectedDatasetId wrinkle

The capture record excludes `selectedDatasetId` (UI focus, no pixel impact). Without intervention, a recipient opens the link and lands with side-panel controls pointing at a different dataset than the sender was tweaking — pixels match, follow-up exploration starts on the wrong control surface.

Resolution (option c per [[queue]]): the applier auto-selects the first *visible* dataset in `dataset_order` after apply via the `subscribeApplyResult` channel. Deterministic, matches user expectation ("controls work on what I'm seeing"), no schema bloat. Implemented in `applier.ts::emitApplyResult`; consumed by `useSavedViewSync` → `App.tsx::handleApplyResult`.

## Interactions

- **Producer (web)**: every viewport-mutating action triggers urlSync's debounce. The toolbar `ShareToolbarButton` reads the current URL and copies to clipboard with size + local-file warnings. The legacy `BookmarkSidebar` "Save current view" calls `captureBuilder` → POST `/api/bookmarks`; the workspace sidebar calls `captureBuilder` → POST `/api/workspaces/:workspace_id/saved-views`.
- **Producer (server)**: REST handlers under `/api/bookmarks` mutate the store; `broadcast.rs` dispatches `BookmarkChanged` after success.
- **Consumer (web)**: `urlSync` bootstrap recognizes `#view=…` and `#b=<id>` on load and `popstate`. `useBookmarks` lists by current dataset URLs and subscribes to `BookmarkChanged` for live updates. `LoadingViewBanner` subscribes to applier state for recipient-apply progress.
- **Auth gate**: every `/api/bookmarks/*` route runs through `AuthPrincipal` middleware (the existing `SessionCookieExtractor`). Unauthed `#b=<id>` URLs go through `UnauthLanding`, which preserves the hash through the OAuth flow, so the bookmark loads after sign-in transparently.

## Invariants

- **The URL always reflects the user's current view, inline-encoded.** Bookmarks are addressable artifacts; `#b=<id>` is an explicit alternate share path. The applier's URL-collapse-to-`#view=…` after `#b=<id>` apply maintains this.
- **Self-broadcast is intentional.** The originating client receives the same `BookmarkChanged` as everyone else. Optimistic local state from `useBookmarks` reconciles cleanly because the broadcast-driven refetch returns the same canonical row.
- **Bookmark CUD broadcast scope = overlapping loaded datasets.** Empty `dataset_urls` → broadcast-to-all (bookmarks made before any dataset is loaded reach every connected client; intentional).
- **Schema versioning is additive-by-default.** `SavedView` fields all carry `#[serde(default)]`, so an older server's `view_json` deserializes against a newer schema without migration. Breaking changes (rename, semantic shift) require bumping `v` and a migration story.
- **`BookmarkStore::delete` returns `Result<Option<Bookmark>, _>`** — the deleted row's `dataset_urls` are needed for broadcast scope. Future store backends must match.

## Gotchas

- **`WasmScene.dataset_volume_shape` returns `[Z, Y, X]` only** — `t`/`c` not surfaced through that API. The applier conservatively only clamps `z`; t/c pass through unmodified (the WASM `set_t`/`set_c` accept any u32). If a stored bookmark references a dataset that has shrunk in t/c since capture, the user sees the WASM-side behavior (no clamp), not a friendly bound-check.
- **Web-side URL → DatasetId map is populated only on local opens.** Datasets opened by *other peers* won't have an entry, so they're omitted from any `SavedView` this client emits. Correct behavior (you can't share what you don't know the URL of) but worth knowing when debugging "why isn't my colleague's dataset in the share link."
- **URL collapse after `#b=<id>` apply is intentional.** The URL is rewritten to `#view=…` after applying a bookmark so further pans don't drift back to the snapshot. `BookmarkChanged` Updated/Deleted broadcasts must NOT re-rewrite the URL hash — the user has moved on from that bookmark.
- **`captureBuilder` excludes a dataset from a `SavedView` when its URL is unknown** — i.e. opened by a peer, so it's absent from this client's URL→DatasetId map (you can't share a dataset whose URL you don't have). The exclusion is silent.
- **Pre-auth `dev@local` bookmarks** created during the auth design phase carry `created_by: "dev@local"`. Cutover policy at production rollout is recorded in [[queue]].
- **Dataset URLs in saved views are visible to anyone with the link.** Presigned URLs and similar credentialed URLs are exposed via clipboard, browser history, screenshots, copy-paste. See [[gotchas/saved-view-credentials-in-urls]].
- **Workspace saved views are not source-open recipes.** In workspace mode, `SavedView.datasets` is empty and the applier never opens source URLs. Missing `workspace_dataset_id` references partially apply with warnings.
- **`UrlSync` is one-shot-by-default in dev.** React Strict-Mode double-invokes mount effects; without re-arming `start()` after `destroy()`, the URL silently never updates. Bit us in PR #483 hours after shipping. See [[gotchas/strict-mode-destroyable-classes]].
- **JS-only preferences don't round-trip without a dedicated SavedView field.** WASM scene state captures cleanly via `export_presence`; React-state preferences (e.g. `autoContrastMap`) that *mutate* WASM state from the JS side will be silently overridden by the recipient's defaults. Caught with auto-contrast in PR #484. See [[gotchas/saved-view-client-only-state]] for the fix pattern when adding new client-only preferences.

## Related

- [[decisions/0013-url-as-app-state-for-saved-views]] — Y-model choice
- [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] — local-file warn-and-embed
- [[decisions/0015-server-stored-bookmarks-and-auth-seam]] — SQLite + AuthPrincipal seam
- [[decisions/0001-document-vs-viewport-split]] — why `BookmarkChanged` is unsequenced
- [[flows/saved-view-recipient-apply]] — end-to-end recipient trace
- [[gotchas/saved-view-credentials-in-urls]] — URL-exposure footgun
- [[gotchas/axum-query-multivalue]] — repeated `?dataset=` parsing wrinkle
- [[presence-and-follow-mode]] — the discrete-snapshot counterpart
- [[lucida-core]], [[lucida-server]], [[lucida-web]] — the three crates this subsystem spans
