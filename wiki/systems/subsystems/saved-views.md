---
type: Subsystem
title: "Saved Views"
description: "Cross-cutting subsystem spanning lucida-core (the SavedView schema), lucida-web (encoder, applier, URL sync, sidebar UI), and lucida-server (the workspace-scoped SQLite saved-view store and REST API)."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/saved-views.md
created: 2026-05-08
modified: 2026-07-17
---

# Saved Views

Cross-cutting subsystem spanning [lucida-core](../crates/lucida-core.md) (the `SavedView` schema), [lucida-web](../crates/lucida-web.md) (encoder, applier, URL sync, sidebar UI), and [lucida-server](../crates/lucida-server.md) (the SQLite-backed workspace saved-view store and REST API). It provides two link forms over one capture record:

1. **Live URL** (`#view=…`) — debounced `window.history.replaceState` keeps the URL hash a current snapshot of the view. Sharing = copy URL. Refresh preserves view. No server involvement.
2. **Workspace saved-view link** (`#b=<id>`) — an address for a named row under `/api/workspaces/:workspace_id/saved-views`. Each row carries creator metadata and a **visibility** (`Shared` / `Personal` / `Proposed`; see below). Editors create/update/rename/delete shared views and set/clear the workspace default; any member (viewer included) can keep `Personal` views and *propose* one for sharing; viewers can list/open/copy. Payloads use workspace-local dataset ids and intentionally omit source URLs.

## Why two surfaces, one record

The capture record (`SavedView`) is the same shape both ways. A `#b=<id>` resolves the id inside the workspace named by `/w/:workspace_id`, hands the row's `view` to the same applier as `#view=…`, then uses `replaceState` to collapse the URL to `#view=…` so later pans advance from the applied snapshot. The server-stored form adds naming, ownership, visibility, and a stable id without creating a second view schema.

Full design rationale starts in [URL-as-App-State for Saved Views](../../decisions/0013-url-as-app-state-for-saved-views.md) (the Y-model choice over encode-on-demand). [Server-Stored Bookmarks and the AuthPrincipal Seam](../../decisions/0015-server-stored-bookmarks-and-auth-seam.md) records the historical predecessor and the reusable auth seam; [ADR-0043](../../decisions/0043-superseded-server-surfaces-sunset.md) makes workspace saved views the sole active server store.

## The capture record

`SavedView` lives in [lucida-core](../crates/lucida-core.md) (`saved_view.rs`) so both web (encode/decode/apply) and server (validate/store) reference the same schema. Fields mirror what's in [`PresenceState`](presence-and-follow-mode.md) for the per-client surface plus `datasets` and `active_layouts` for the document-state surface:

- `v: 1` — schema version. Decoder rejects payloads without it. `v > 1` decodes known fields with a console warning (best-effort, never refuse — refusing means a stale tab opening a fresh link breaks).
- `datasets`, `active_layouts`, `dataset_order`, `dataset_settings` — multi-dataset shape and per-dataset visibility/contrast/colormap.
- `camera`, `view`, `display` — same types as `PresenceState`.
- `auto_contrast: IndexMap<DatasetId, bool>` — JS-side preference (lives in `useDatasetSettings.autoContrastMap`, not in WASM) that round-trips explicitly so the recipient's intensity batcher doesn't immediately overwrite captured contrast values. `IndexMap` (not `HashMap`) like every per-dataset map here, so deserialize→serialize preserves key order — load-bearing for deterministic on-the-wire serialization of the collaborative document. Pattern to follow when adding new client-only state — see [SavedView Mirrors WASM Presence — Client-Only State Won't Round-Trip Without a Dedicated Field](../../gotchas/saved-view-client-only-state.md).

Notable exclusions per [URL-as-App-State for Saved Views](../../decisions/0013-url-as-app-state-for-saved-views.md): `selectedDatasetId` (UI focus only — but see "selectedDatasetId wrinkle" below), `following` (sender's follow target irrelevant to recipient), `cursor` (mouse position is noise), `client_id` (not portable).

Beyond the two link forms above, `SavedView` is also embedded as `Annotation::view: Option<SavedView>` (`saved_view.rs`): an annotation captures its author's view so jump-to-annotation can restore it. This makes `SavedView`'s `PartialEq` derive load-bearing (`Annotation` derives `PartialEq`).

## Three deep modules on the web side

All under `lucida-web/src/savedView/`:

- **`encoder.ts`** — pure `encode(SavedView) → string` and `decode(string) → SavedView`. Default-stripping on encode (don't emit `gamma: 1.0`, `visible: true`, etc.); restore on decode. `CompressionStream` for gzip; base64url for the URL-safe wrapper. The encoder owns the `v: 1` discipline.
- **`applier.ts`** — async orchestrator. Diffs current vs target datasets, opens missing via `bridge.sendOpenRemoteDataset`, awaits dataset-open results, then applies in fixed order: layouts → dataset_order → per-dataset settings → global display → view dimensions → camera last. Manages `applyInProgress` flag (urlSync reads to suppress writes). Surfaces `OpenDatasetFailed` to the loading-banner state. Out-of-range z/t/c values clamp with a non-blocking notice; a missing layout falls back to the dataset's default.
- **`urlSync.ts`** — bootstraps from `window.location.hash` on initial load (handles both `#view=…` and `#b=<id>`), subscribes to viewport/scene change events, debounces 250-500 ms idle, encodes + `replaceState`. Listens for `popstate`. Reads `applyInProgress` to break the apply/sync feedback loop. Initial framing has one ordered policy: explicit hash → viewer profile → remembered last view → workspace default → host fallback. The fallback fits the first ordered snapshot dataset only when none of the persisted sources applied, so refresh joins are framed without competing with a user's saved camera.

The `subscribeApplyResult` channel on the applier is the seam for UI-state that doesn't live in the WASM scene (currently just the `selectedDatasetId` auto-select). Future capture-record fields needing similar after-apply effects should subscribe here.

## Historical bookmark-store rows

[ADR-0043](../../decisions/0043-superseded-server-surfaces-sunset.md) retired the organization-global bookmark implementation: `lucida-server/src/bookmarks/`, `/api/bookmarks`, the `BookmarkChanged` wire notification, and the unused web hook/API are gone. The original `bookmarks` and `bookmark_datasets` migrations remain in the immutable migration ledger, and existing rows are deliberately left untouched. They are inert unless an operator runs the explicit offline recovery command below; there is no runtime compatibility route.

## Recovering a retired bookmark

Use `lucida-server recover-legacy-bookmark` against a fully migrated SQLite database. Stop the server and take the normal SQLite backup first. The command refuses to create a missing database and is a read-only dry run unless `--apply` is present.

Dry-run and inspect the plan:

`lucida-server recover-legacy-bookmark --db-path /var/lib/lucida/lucida.db --bookmark <bookmark-id> --workspace <workspace-id> --json`

Then rerun the same command with `--apply` to commit. Personal visibility is the safe default. `--visibility shared` is available only when the selected creator is an editor or owner; `--creator <member-email>` explicitly reattributes a row whose historical creator is no longer a member.

Recovery matches every legacy dataset URL to the chosen workspace's canonical dataset memberships, recognizes both historical short/raw-URL and current full/canonical `ds-*` identities, rewrites `active_layouts`, `dataset_order`, `dataset_settings`, and `auto_contrast` onto `wds-*` ids, then clears `SavedView.datasets`. The printed/JSON mapping exposes a credential-and-path-free source hint plus the canonical source hash—not the raw URL—so a dry-run plan is safe to retain in operator logs. Missing mappings, ambiguous mappings, stale dataset-id references, invalid creators, and id collisions all fail before the transaction writes. The original bookmark id is retained as the workspace saved-view id, so an exact rerun is idempotent and the old `#b=<id>` becomes meaningful again only under that chosen workspace URL.

Failure output is also a stable operator interface. With `--json`, failure exits nonzero, writes exactly one compact `{ "ok": false, "error": { "code", "message", "source"? } }` document to stdout, and leaves stderr empty. Without `--json`, failure exits nonzero and writes one safe human-readable line to stderr while leaving stdout empty. Source diagnostics contain only a path/credential-free hint plus an opaque full fingerprint; unvalidated bookmark, workspace, dataset, creator, and role values are bounded and validated before display or replaced by a fingerprint. Raw locators, userinfo, object paths, query strings, parse errors, and SQL errors never cross either output boundary.

## Server side: workspace saved views

Workspace saved views live in `lucida-server/src/workspace/` alongside workspace authorization and dataset membership. The `workspace_saved_views` table stores `view_json` plus name/creator timestamps and a `visibility` TEXT column (migration `...0011`; a partial index on proposed rows in `...0013`), keyed by `workspace_id`; there is no dataset URL side table because source identity belongs to `workspace_datasets`.

All routes are workspace-scoped:

- `GET /api/workspaces/:workspace_id/saved-views`
- `POST /api/workspaces/:workspace_id/saved-views`
- `GET/PATCH/DELETE /api/workspaces/:workspace_id/saved-views/:saved_view_id`
- `PATCH /api/workspaces/:workspace_id/saved-views/:saved_view_id/visibility` — re-scope a view's visibility
- `POST /api/workspaces/:workspace_id/saved-views/:saved_view_id/approve` / `/reject` — editor disposition of a `Proposed` view
- `GET/PATCH /api/workspaces/:workspace_id/viewer-profiles/:profile` — per-viewer last-open view (#700), isolated per `principal.email`
- `PATCH /api/workspaces/:workspace_id/default-saved-view`

The manager enforces viewer-or-better for list/get and editor-or-better for create/update/delete/default changes. On create/update, the server clears `SavedView.datasets` before persistence; workspace saved views are expected to key `dataset_order`, `dataset_settings`, `active_layouts`, and `auto_contrast` by `workspace_dataset_id`.

### Visibility model (`Shared` / `Personal` / `Proposed`, #702)

`SavedViewVisibility` (in `workspace/types.rs`) governs who can see each workspace saved view:

- **`Shared`** — the collaborative surface (the historical default); visible to every member, editable by editors.
- **`Personal`** — belongs to exactly one member, never disclosed to anyone else (not even owners).
- **`Proposed`** — a viewer's *bid to share*: like a `Personal` view it belongs to one member, but it is surfaced to editors as a review queue. An editor can **approve** (→ `Shared`) or **reject** (→ back to the proposer's `Personal`). A proposer cannot be their own reviewer (self-approve guard, #817) — the approve path forbids `created_by == reviewer` even for an editor/owner who authored the proposal; self-*reject*/withdraw is legal via `/visibility`. The whole visibility predicate is resolved in SQL so a denied row is never read. The web side mirrors this with `WorkspaceSavedViewVisibility` and `approveWorkspaceSavedView`/`rejectWorkspaceSavedView` in `workspaceApi.ts`.

`/w/:workspace_id#b=<saved_view_id>` resolves through the workspace-scoped API and collapses to `/w/:workspace_id#view=...` after a successful apply. Bare `/w/:workspace_id` applies `default_saved_view_id` when one is configured and no explicit hash is present.

## Saved-view changes are REST-local, not session messages

Workspace saved-view CRUD does not enter the sequenced document stream and has no separate WebSocket notification. The mutation response is the canonical row; `useWorkspaceSavedViews` updates its local list from that response and exposes `refresh()` for reconciliation. Opening `#b=<id>` always resolves the canonical row from the workspace REST API before applying it. Concurrent tabs therefore reconcile on their next refresh rather than through session broadcast traffic.

## Local-file dataset sharp edge

URLs classified as local by `lucida_content::url::is_local_dataset_url` (canonical Unix `/foo`, drive-letter `c:/foo`, UNC `//server/share/foo` — see [Canonical dataset URL form](../../decisions/0042-canonical-dataset-url-form.md)) are embedded in saved views in canonical form. Trusted library/Python opens use `LocalFileSystem`; server opens retain a separately admitted descriptor-confined capability. `dataset_id_for_url` is BLAKE3 of the *canonical* URL string — content-derived from the string after normalization, not the file bytes. Two consequences:

- For the **sender on their own server**: refresh-preserves works as for cloud datasets (same path → same file → same `DatasetId`).
- For a **recipient on a different server**: same path may not exist, may be outside `data_dir`, or worst case may resolve to a *different* file with the same path on a different machine — silently loading the wrong dataset and applying viewport state meaningful for the original.

The `ShareToolbarButton` warns at share time when the current URL contains local-file paths. Recipients of failures get partial-apply with inline indicators. See [Local-File Datasets Are Personal-Only in Saved Views](../../decisions/0014-local-file-datasets-personal-only-in-saved-views.md) for the full rationale and the documented `DatasetId`-collision-on-different-content sharp edge.

## selectedDatasetId wrinkle

The capture record excludes `selectedDatasetId` (UI focus, no pixel impact). Without intervention, a recipient opens the link and lands with side-panel controls pointing at a different dataset than the sender was tweaking — pixels match, follow-up exploration starts on the wrong control surface.

Resolution (option c per [Queue — Open Questions](../../queue.md)): the applier auto-selects the first *visible* dataset in `dataset_order` after apply via the `subscribeApplyResult` channel. Deterministic, matches user expectation ("controls work on what I'm seeing"), no schema bloat. Implemented in `applier.ts::emitApplyResult`; consumed by `useSavedViewSync` → `App.tsx::handleApplyResult`.

## Interactions

- **Producer (web)**: every viewport-mutating action triggers urlSync's debounce. The toolbar `ShareToolbarButton` reads the current URL and copies it with size + local-file warnings. `WorkspaceSavedViewsSidebar` captures the current view and calls the workspace-scoped REST API; `useWorkspaceSavedViews` owns list/filter/mutation state.
- **Producer (server)**: workspace REST handlers validate membership and visibility, strip source URLs, and persist the canonical row in `workspace_saved_views`.
- **Consumer (web)**: `urlSync` recognizes `#view=…` and `#b=<id>` on load and `popstate`. The production resolver in `App.tsx` calls `getWorkspaceSavedView(workspaceId, id)`; `LoadingViewBanner` subscribes to applier state for recipient-apply progress.
- **Auth gate**: workspace membership and saved-view visibility are enforced by `WorkspaceManager`. An unauthenticated workspace URL goes through `UnauthLanding`, which preserves the path and hash across OAuth so resolution resumes after sign-in.

## Invariants

- **The URL always reflects the user's current view, inline-encoded.** A workspace saved view is an addressable artifact; `#b=<id>` is the stable entry path. Collapsing it to `#view=…` after apply keeps subsequent navigation live.
- **`#b` ids are workspace-relative.** Resolution always includes the current `workspace_id`; an id copied under one workspace cannot escape that workspace's authorization boundary.
- **Saved-view mutations are not document commands.** They persist through workspace REST and do not consume sequence numbers or appear in session snapshots.
- **Schema versioning is additive-by-default.** `SavedView` fields all carry `#[serde(default)]`, so an older server's `view_json` deserializes against a newer schema without migration. Breaking changes (rename, semantic shift) require bumping `v` and a migration story.

## Gotchas

- **`WasmScene.dataset_volume_shape` returns `[Z, Y, X]` only.** The applier combines that shape with the current manifest dimensions when clamping the saved view and reports moved axes through a non-blocking notice. Keep those sources aligned if the WASM shape grows.
- **Source-URL capture is a separate mode.** `captureBuilder` can build source-URL records for non-workspace callers, but the product workspace path uses `workspace-dataset-id`, leaves `SavedView.datasets` empty, and keys settings/layouts by `wds-*` ids.
- **URL collapse after `#b=<id>` apply is intentional.** The URL is rewritten to `#view=…` after applying the saved view so further pans do not drift back to the snapshot. Later changes to the stored row do not rebind an already-open tab.
- **Legacy bookmark rows do not resolve through `#b`.** The hash now means a workspace saved-view id only. Recover an old row with the offline `lucida-server recover-legacy-bookmark` workflow before trying to share it.
- **Dataset URLs in saved views are visible to anyone with the link.** Presigned URLs and similar credentialed URLs are exposed via clipboard, browser history, screenshots, copy-paste. See [Saved-View URLs Expose Dataset URLs (and Anything in Them)](../../gotchas/saved-view-credentials-in-urls.md).
- **Workspace saved views are not source-open recipes.** In workspace mode, `SavedView.datasets` is empty and the applier never opens source URLs. Missing `workspace_dataset_id` references partially apply with warnings.
- **`UrlSync` is one-shot-by-default in dev.** React Strict-Mode double-invokes mount effects; without re-arming `start()` after `destroy()`, the URL silently never updates. Bit us in PR #483 hours after shipping. See [React Strict-Mode Kills One-Shot `destroy()` Classes](../../gotchas/strict-mode-destroyable-classes.md).
- **JS-only preferences don't round-trip without a dedicated SavedView field.** WASM scene state captures cleanly via `export_presence`; React-state preferences (e.g. `autoContrastMap`) that *mutate* WASM state from the JS side will be silently overridden by the recipient's defaults. Caught with auto-contrast in PR #484. See [SavedView Mirrors WASM Presence — Client-Only State Won't Round-Trip Without a Dedicated Field](../../gotchas/saved-view-client-only-state.md) for the fix pattern when adding new client-only preferences.

## Related

- [URL-as-App-State for Saved Views](../../decisions/0013-url-as-app-state-for-saved-views.md) — Y-model choice
- [Local-File Datasets Are Personal-Only in Saved Views](../../decisions/0014-local-file-datasets-personal-only-in-saved-views.md) — local-file warn-and-embed
- [Server-Stored Bookmarks and the AuthPrincipal Seam](../../decisions/0015-server-stored-bookmarks-and-auth-seam.md) — historical predecessor + the surviving `AuthPrincipal` seam
- [Sunset dispositions for the three superseded server surfaces](../../decisions/0043-superseded-server-surfaces-sunset.md) — workspace saved views absorb the former bookmark surface
- [Document vs Viewport Command Split](../../decisions/0001-document-vs-viewport-split.md) — why saved-view REST mutations stay outside the document stream
- [Flow: Saved-View Recipient Apply](../../flows/saved-view-recipient-apply.md) — end-to-end recipient trace
- [Saved-View URLs Expose Dataset URLs (and Anything in Them)](../../gotchas/saved-view-credentials-in-urls.md) — URL-exposure footgun
- [Axum's Default Query Extractor Drops Repeated Keys](../../gotchas/axum-query-multivalue.md) — repeated `?dataset=` parsing wrinkle
- [Presence and Follow Mode](presence-and-follow-mode.md) — the discrete-snapshot counterpart
- [lucida-core](../crates/lucida-core.md), [lucida-server](../crates/lucida-server.md), [lucida-web](../crates/lucida-web.md) — the three crates this subsystem spans
