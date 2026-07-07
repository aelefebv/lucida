---
type: Decision
title: "Sunset dispositions for the three superseded server surfaces"
description: "End-state decisions for the global /ws session, the bookmarks store, and the proxy/asset fallback protocol — retire, absorb, and delete respectively, each with a verified consumer list and a migration/deletion path."
tags: [lucida, decision]
source_path: wiki/decisions/0043-superseded-server-surfaces-sunset.md
created: 2026-07-04
modified: 2026-07-06
---

# Sunset dispositions for the three superseded server surfaces

Status: **Accepted** (2026-07-04, repository owner). Each disposition executes as its own named follow-up change.

Three server surfaces predate the current workspace/chunk-tier architecture and still coexist with it: the global `/ws` session, the bookmarks store, and the proxy/asset fallback protocol. Each duplicates a newer surface, and every session-shaped feature (the lagged-broadcast resync path in `lucida-server/src/handler.rs` being the freshest example) must be reasoned about across both generations. This ADR fixes an end-state for each. All consumer claims below were verified against the current code; module paths cite the evidence.

## A. Global `/ws` session — retire

**Disposition: retire the route and the global runtime; no "default workspace" bridge.**

`AppState` in `lucida-server/src/lib.rs` carries a runtime quadruple (`session`, `tx`, `next_id`, `unicast_routes`) that `LiveWorkspace` in `lucida-server/src/workspace/manager.rs` duplicates field-for-field. Both feed the shared `handle_client_inner` loop (`lucida-server/src/handler.rs`) via two thin wrappers; the global one is mounted at `/ws` (`lucida-server/src/main.rs`), the per-workspace one at `/ws/workspaces/{workspace_id}` (`lucida-server/src/workspace/http.rs`).

Consumer survey — nothing shipped can reach `/ws`:

- **Web**: `lucida-web/src/bridge.ts` falls back to `/ws` only when constructed without a `workspaceId`. The sole production construction (`lucida-web/src/hooks/useBridge.ts`) always passes one, and `App` mounts only under `WorkspaceRoot`'s parsed `/w/:id` route (`lucida-web/src/WorkspaceRoot.tsx`; `main.tsx` renders nothing but `WorkspaceRoot`). The fallback branch is reachable from tests alone.
- **CLI**: every WebSocket client in `lucida-cli/src/{view,dataset,saved_view,layout}.rs` connects via `WorkspaceTarget::ws_url`, built exclusively by `workspace_ws_url` (`lucida-cli/src/workspace.rs` — the URL builder; it opens no sockets itself) as `/ws/workspaces/{id}`. The manual escape hatch suggested in the `main.rs` route comment ("pass `--server ws://…/ws`") no longer parses: `lucida-cli/src/config.rs` rejects `ws://` base URLs.
- **Python**: `lucida-py/python/lucida/client.py` builds only `ws/workspaces/{id}` URLs.
- **Tests**: `lucida-server/tests/lagged_resync_e2e.rs` and `tests/saved_views_broadcast_e2e.rs` assemble their own quadruple around `handler::handle_client` / synthetic `unicast_routes`. They consume the *handler shape*, not the production route, and can be re-hosted on a `LiveWorkspace`-backed rig (or keep constructing the quadruple directly).
- **Bookmarks broadcast**: `main.rs` wires `BookmarkChanged` fanout to the global session's `session`/`unicast_routes` only — so in production, where every client is a workspace client, the broadcast reaches no one (see B).

**Why retire rather than converge onto a "default workspace":** there is no user or data to migrate — the global session is in-memory, unpersisted, uses URL-derived `ds-*` dataset ids (vs the workspace `wds-*` split, `dataset_open.rs::new_workspace_dataset_id`), and has no workspace authorization by design. Synthesizing a default workspace would *add* a persistence and access-policy story for a path with zero consumers, and would contradict [Surface Parity](../principles/surface-parity.md): every surface is already workspace-first.

**Migration path** (one follow-up): re-host the two e2e rigs; delete the `/ws` route, `ws_handler`, and `handler::handle_client`; shrink `AppState` to `data_dir` + `proxy_config` (still needed by `/api/browse` and the admin cache route); remove the `bridge.ts` non-workspace fallback and the `/ws` entry in `lucida-web/vite.config.ts`; resolve the bookmark-broadcast wiring per B. `session.rs` itself is untouched — `LiveWorkspace` owns the same `Session` type.

**Trade-off:** `/ws` was the last workspace-free WebSocket entry point for ad-hoc harnesses (it still sits behind the auth middleware, so it was never auth-free). Headless scripts must create-or-target a workspace first — in disabled auth mode that is one `POST /api/workspaces`.

## B. Bookmarks store vs workspace saved views — workspace saved views absorb

**Disposition: converge. Workspace saved views ([ADR-0015](0015-server-stored-bookmarks-and-auth-seam.md)'s successor surface) are the one server-stored saved-view store; retire the bookmarks REST/wire/web surface. Keep the SQLite rows.**

Both stores serialize the same `lucida_core::saved_view::SavedView`: `lucida-server/src/bookmarks/store.rs` (`bookmarks` + `bookmark_datasets` tables, org-global, dataset-URL-keyed) and `lucida-server/src/workspace/store/sqlite.rs` (`workspace_saved_views`, workspace-scoped, with the visibility/approval workflow).

Consumer survey — the bookmarks surface has no live producer or consumer:

- **Writers**: none. The live sidebar (`lucida-web/src/components/WorkspaceSavedViewsSidebar.tsx`) posts to `/api/workspaces/{id}/saved-views`; the old `BookmarkSidebar` component was removed (#819).
- **Readers**: `lucida-web/src/savedView/urlSync.ts` defaults its `#b=<id>` resolver to `bookmarksApi.getBookmark`, but the production host always overrides it with `getWorkspaceSavedView` (`lucida-web/src/App.tsx`, `fetchSavedViewById`). The `useBookmarks` hook (`lucida-web/src/savedView/useBookmarks.ts`) has no live call site — only its own test and a re-exported time helper.
- **Wire**: `ServerMessage::BookmarkChanged` (`lucida-core/src/protocol.rs`) is dispatched only into the global `/ws` session (`main.rs` `BookmarksState` wiring) — unreceivable by workspace clients. Workspace saved-view mutations broadcast nothing; the sidebar is refetch-driven (`lucida-server/src/workspace/http.rs`).
- **CLI**: no bookmark commands. `lucida saved-view link` (`lucida-cli/src/saved_view.rs`) emits `#b=<id>` where the id is a *workspace* saved view — the hash name already denotes the successor store in practice.
- **Data**: the bookmarks migration (`lucida-server/migrations/20260508000003_create_bookmarks.sql`) predates workspaces (`20260528000004`) by three weeks, so production DBs may hold bookmark rows that no shipped UI can list anymore.

**What absorb means concretely:** delete `lucida-server/src/bookmarks/` and the `/api/bookmarks*` routes; delete `ServerMessage::BookmarkChanged` + `BookmarkAction`, the golden `wire-fixtures/session/server_bookmark_changed.json`, and the `bookmark_actions` entry in `wire-fixtures/vocab/enum_vocabulary.json` (regenerate the vocab golden — the `vocab!` exhaustive-match tripwire in `lucida-server/tests/wire_goldens.rs` makes the enum deletion a compile error until the list is updated); delete `useBookmarks.ts`, `bookmarksApi.ts` (moving the `#b=` resolver default into the workspace API), and the bridge `bookmark_changed` case + `subscribeBookmarkChanged` plumbing. The `#b=<id>` hash form is *kept* and formally redefined as "workspace saved-view id". Removing the wire variant is skew-safe: it is unsequenced and refetch-repaired (see [Saved Views](../systems/subsystems/saved-views.md) §"BookmarkChanged is unsequenced"), the bridge's message switch drops unknown types silently, and the single-image deploy unit ([ADR-0020](0020-single-image-with-servedir.md)) bounds client/server skew to a reload.

**Existing rows:** no destructive migration. The `bookmarks`/`bookmark_datasets` tables stay in place (their migration remains in the ledger), and the follow-up documents a one-off SQL graft for anyone who wants an orphaned row moved into `workspace_saved_views` — the `view` payload is the same `SavedView` JSON, so the graft is an INSERT plus a target workspace choice.

**Trade-off (the strongest counter-argument):** bookmarks were the only *cross-workspace*, dataset-keyed discovery surface — ADR-0015's headline feature ("show me other people's analyses of this dataset"). Workspace saved views are siloed per workspace, so this forecloses cross-workspace discovery until someone rebuilds it as a workspace-aware query. Mitigating fact: that capability has had no UI since #819, so keeping the dormant store preserves rows, not the feature.

## C. Proxy/asset fallback protocol — delete, including `lucida-proxy`

**Disposition: delete the entire path in a named follow-up. [ADR-0039](0039-chunk-only-coarse-detail-residency.md) already ruled "proxy compatibility is temporary … should be deleted"; this ADR declares the bridge period over and names the inventory.**

Reachability — no supported configuration reaches the fallback end-to-end. The decisive gate is server-side:

- **Server side (the gate that keeps the lane dead)**: `legacy_proxy_enabled` defaults to `false` (`lucida-server/src/lib.rs`, `ProxyConfig::defaults`); the only setters are `--legacy-proxy-enabled` / `LUCIDA_LEGACY_PROXY_ENABLED` (`lucida-server/src/main.rs`). When false, `DatasetOpened` carries an empty catalog and background pre-generation gets an empty work list (`lucida-server/src/dataset_open.rs`, `proxy_catalog_entries_for_manifest`), and every incoming `AssetMessage::AssetRequest` is rejected at the per-binding gate in the dispatch loop (`lucida-server/src/handler.rs`) — whatever the client sends.
- **Client side**: the shipped web client *can* emit `asset_request` — planning's `coarseDetailEnabled` (default `true`, `lucida-web/src/pipeline/planning/config.ts`) has a live persisted setter in the debug panel (`lucida-web/src/debug/ConfigTab.tsx` via `configStore`, `lucida-web/src/pipeline/planning/configStore.ts`, persisted under `localStorage["lucida.planning.config"]`), and flipping it off routes planning through the catalog-aware mode assignment into the proxy request lane (`modes.ts::assignModes`, `proxyResidency.ts`, `contentSource.ts::fetchProxy`). But that knob is a hidden debug-tab toggle, not a supported user surface — it is itself slated for gating under the tracked debug-tooling issue (bead lucida-s6m) — and against a default-configured server it is moot anyway: the empty catalog leaves the degrade path nothing to request, and any `asset_request` that does arrive is dropped at the gate above. Exercising the fallback therefore takes an operator-set server flag *and* a debug-tab client toggle, in concert; neither is a supported path. A "keep with trigger condition" disposition is not honest on these terms: no deployment can drift into the fallback on its own, so the trigger could never fire in the field.
- **`lucida-proxy` has no consumer outside this path.** Generated coarse implements its own downsampling (`lucida-server/src/generated.rs`, `DOWNSAMPLE_ALGORITHM_VERSION`) and imports nothing from `lucida_proxy`. The crate's only dependents are `lucida-server`'s proxy modules and `lucida-protocol`'s `ProxyKind` re-export (`lucida-protocol/src/asset.rs` — the protocol-depends-on-compute layering wart tracked as bead lucida-b0u, which this deletion resolves). So the crate retires with the path.

**Deletion inventory:**

- *Server*: `lucida-server/src/proxy/` (mod, cache, catalog, generator, server_source); the `AssetMessage` dispatch arm, `serve_asset_request`, and the binary proxy-frame builder in `handler.rs`; `ServerBinding.{legacy_proxy_enabled, proxy_cache, proxy_generator}` (`binding.rs`); the catalog build + `(T=0,C=0)` pre-generation block in `dataset_open.rs`; `ProxyConfig.{legacy_proxy_enabled, concurrency}` (`lib.rs`) and the serve flag (`main.rs`); tests `proxy_cache_test.rs`, `proxy_generator_test.rs`. **Keep** the cache-root config, `admin clear-proxy-cache`, and the `clear-proxy-cache` subcommand, re-rooted at the generated-coarse cache (which nests under the proxy cache dir today, `ProxyConfig::default_generated_cache_dir`).
- *Wire*: `lucida-protocol/src/asset_request.rs` (`AssetMessage`) and `asset.rs` (`AssetCatalog`, `AssetCatalogDelta`, `ProxyAvailability`, the `ProxyKind` re-export); `DatasetOpened.catalog` (`register.rs`); `ServerMessage::AssetCatalogUpdate` (`lucida-core/src/protocol.rs`); `DocumentCommand::ApplyAssetCatalogDelta` (`lucida-core/src/command.rs`) plus `apply_asset_catalog_delta` in `lucida-core/src/wasm.rs` and `scene/types.rs`. Also the adjacent dead relay protocol: `ChunkMessage::ChunkFetch` (accepted-and-ignored in `handler.rs`, never constructed outside protocol tests) and the inbound client→server binary chunk-relay arm (no shipped client sends binary frames; `lucida-py` errors on binary receipt). **Not** in scope: `FetchSource::Proxied` / `ProxiedFetchDescriptor` (`lucida-protocol/src/fetch.rs`) — despite the name, that is the *live* server-relayed chunk descriptor built on every import (`lucida-store/src/import.rs`); a rename would help, separately.
- *Wire goldens*: delete `session/asset_request.json`, `session/server_asset_catalog_update.json`, `session/client_command_apply_asset_catalog_delta.json`; remove the `proxy_kinds` entry from `wire-fixtures/vocab/enum_vocabulary.json` and regenerate (same `vocab!` compile-forced list edit as B's `bookmark_actions`); regenerate `dataset-open/dataset_opened_single.json` / `dataset_opened_collection.json` (the `catalog` field leaves `DatasetOpened` — skew-safe in both directions because the field is `#[serde(default)]` on the Rust side and unread by the chunk-tier web path). `dataset-open/fetch_source_proxied.json` stays (live descriptor, above).
- *Web*: the non-chunk-tier planning path (`modes.ts::assignModes` + `degradeForCatalog`, `proxyResidency.ts`, the three promotion-mode `ActiveSetEntry` kinds, and — once only one path exists — the `coarseDetailEnabled` flag itself, its `debug/ConfigTab.tsx` toggle, and the key in the persisted `configStore` envelope); the fetch proxy path (`contentSource.ts::fetchProxy` + pending-proxy bookkeeping, proxy header parsing in `wireProtocol.ts`, `proxyStore.ts`, `cpuCache.ts` proxy branches); renderer proxy residue (`renderer/proxy/`, `proxyAtlas.ts`, proxy descriptors + shader fallback branches); `pipeline/assetCatalog.ts`, `session.ts::assetCatalog`, the bridge `asset_catalog_update` case, and the asset epoch in `pipeline/epochs.ts`.
- *Wiki fallout*: [Flow: Proxy Generation](../flows/proxy-generation.md), [Proxy Generator Priority Is Not Honored Yet](../gotchas/proxy-priority-not-honored.md) (the priority scheduler will now never land — this closes the 2026-04-18 queue question), [lucida-proxy](../systems/crates/lucida-proxy.md), and the "still wired" language in [lucida-server](../systems/crates/lucida-server.md) all become historical when the follow-up lands. ADRs [0004](0004-multi-pool-atlases.md)/[0024](0024-catalog-degrade-one-tier-at-a-time.md)/[0025](0025-groups-as-planning-unit.md)/[0038](0038-budgeted-proxy-gpu-residency.md) already record their superseded status.

**Trade-off (the strongest counter-argument):** chunk-only coarse/detail (PRDs #672, [ADR-0039](0039-chunk-only-coarse-detail-residency.md)–[0041](0041-clean-two-source-chunk-tier-renderer.md)) is only weeks old, and deleting the proxy path removes the option of re-enabling it quickly if a dataset class renders badly under the chunk tiers. Mitigating facts: the server flag has defaulted off since the flip with no re-enable since, and "quick re-enablement" was never one switch anyway — it takes the server flag *plus* the hidden debug-tab client toggle flipped in every affected browser, a two-sided incantation no deployment has needed. This is [Principles — Planning Domain](../principles/planning.md#2-memory-is-the-binding-constraint) working as intended: one budgeted fallback tier, not two.

## Consequences

- One session runtime (per-workspace), one saved-view store (workspace-scoped), one fallback pipeline (chunk tiers). New session-shaped features stop paying the dual-path tax `handle_client_inner` imposes today.
- Three independent follow-ups, in any order; A and B touch the same `main.rs` bookmark-broadcast wiring, so whichever lands second deletes it.
- Bead lucida-b0u (ProxyKind's protocol placement) resolves by deletion under C.
- The queue items on proxy-generation priority (2026-04-18) and disabled-mode bookmark ownership (2026-05-07/08) close against this ADR — see [Queue — Open Questions](../queue.md).

## Related

- [Document vs Viewport Command Split](0001-document-vs-viewport-split.md) — the command model both session generations share (unchanged by A)
- [Server-Stored Bookmarks and the AuthPrincipal Seam](0015-server-stored-bookmarks-and-auth-seam.md) — the surface B retires; the `AuthPrincipal` seam it introduced is unaffected
- [Chunk-only coarse/detail residency](0039-chunk-only-coarse-detail-residency.md), [Generated coarse as derived pyramid levels](0040-generated-coarse-as-derived-pyramid-levels.md), [Clean two-source chunk-tier renderer](0041-clean-two-source-chunk-tier-renderer.md) — the successor path C's deletion completes
- [Surface Parity](../principles/surface-parity.md), [Principles — Planning Domain](../principles/planning.md)
- [Workspaces](../systems/subsystems/workspaces.md), [Saved Views](../systems/subsystems/saved-views.md), [lucida-server](../systems/crates/lucida-server.md)
