---
created: 2026-04-18
modified: 2026-06-25
---

# lucida-server

Tokio + Axum WebSocket relay. Brokers multi-client sessions, sequences shared document commands, broadcasts presence, opens datasets via [[lucida-store]], serves source chunks from a `CachedStore`, and generates/serves derived coarse chunks through the normal chunk path. The proxy generator stays wired as a fallback; coarse/detail over source or generated pyramid levels is the default. Per [[decisions/0020-single-image-with-servedir]] it also serves the SPA bundle directly via `tower-http::ServeDir`, so the production deploy unit can be a single container image and a developer's local `:9876` can render the app without an extra reverse proxy.

## Why a relay, not a peer-mesh

Lucida is collaborative: many viewers can see the same dataset and follow each other. The server exists for two reasons:

1. **Document-state arbitration.** Each `DocumentCommand` (e.g. `DatasetOpened`) gets a monotonically increasing `seq` and an `Ack` to the sender. New clients receive a `Snapshot` of the full document state on connect. This makes "what datasets are loaded" a single authoritative fact.
2. **Storage proxy and chunk router.** Browsers can't realistically open arbitrary `gs://` / `s3://` Zarr stores directly with credentials. The server probes the store, builds a [[lucida-content|DatasetManifest]], and on demand fetches/decodes source chunks or generated coarse chunks and forwards them as binary frames to the requesting client. The bytes the client sees are pre-decompressed (Lz4/Zstd → raw for source chunks), keyed by `(dataset_id, image_id, chunk_key)`.

Presence (cursor, viewport, follow) doesn't need arbitration — it's broadcast through the same WebSocket but never sequenced or persisted. See [[decisions/0001-document-vs-viewport-split]].

## Module map

- `lib.rs` — `AppState`, `BroadcastItem` (the in-process pub/sub envelope), `ProxyConfig`
- `main.rs` — Axum server entry point; wires WebSocket handler, admin routes, and the two-router split for [[auth]]
- `handler.rs` — per-client connection loop: snapshot → broadcast subscribe → inbound dispatch (`ClientMessage` / `ChunkMessage` / `AssetMessage` / binary chunk relay)
- `session.rs` — `Session` state: `DocumentState` + history ring buffer + per-client `PresenceState` + `server_bindings: HashMap<DatasetId, ServerBinding>`
- `binding.rs` — `ServerBinding`, `ChunkResolver`; consumes the already-detected `StorageCompression` (detection lives in [[lucida-store]]'s `codec::parse_codec_chain`, an import-time validator)
- `decode.rs` — Lz4/Zstd/Blosc → raw decode (`DecodeError::Lz4`/`Zstd`/`Blosc`, Blosc in the `decode/blosc.rs` submodule), shared between source chunk serving and derived generation
- `health.rs` — unauth public router: `/healthz` (liveness), `/readyz` (readiness), `/version`, for containerized deploys (kubelet probes carry no session cookie)
- `generated.rs` — generated coarse planning, scheduling, cancellation, materialization, derived-cache recovery, and availability broadcasts
- `proxy/` — fallback server-side proxy infrastructure (still wired; coarse/detail is the default): `ProxyCache` (per-dataset on-disk cache), `ProxyGenerator` (bounded-concurrency, in-flight dedup), `ServerProxySource` (adapter from `CachedStore` to `lucida-proxy`'s sync trait)
- `auth/` — Google OAuth + session cookies + admin allowlist + cleanup sweep + audit logging. See [[auth]] for the deep-dive.
- `workspace.rs` — workspace records, membership/link sharing, archive/restore lifecycle, authorization, lazy live-session restore, workspace-scoped document persistence (annotations live in `DocumentState`, so an `AddAnnotation` command is persisted via `persist_document` and broadcast over the session like any other document command), explicit workspace admin support routes under `/admin/workspaces/*`, and REST/WebSocket routes under `/api/workspaces/*` and `/ws/workspaces/:id`.
- `browse.rs` / `admin.rs` — HTTP routes for filesystem browsing and admin operations (e.g. clear proxy cache). `browse_handler`'s `path` query param is optional per [[decisions/0042-canonical-dataset-url-form]]: when absent, the response is a platform-default root — drives list (`c:`, `d:`, ...) on Windows via an A-Z `tokio::fs::metadata` scan, `/` listing on Unix. Returned `path` field is always in canonical-display form (`\\?\` and `\\?\UNC\` prefixes stripped, drive letter lowercased, forward-slashified). `data_dir` security constraint still enforced via segment-aware `starts_with` on canonicalized PathBufs.
- `migrations/` (crate root, `lucida-server/migrations/`, not under `src/`) — versioned SQL migrations applied at startup (sqlx). Persistent state grew with [[auth]] (`login_sessions`, `pending_auth`, plus `bearer_tokens` and `cli_token_authorizations` for non-cookie credentials), [[saved-views]] (`bookmarks` + `bookmark_datasets`), and workspaces (`workspaces`, `workspace_members`, `dataset_sources`, `workspace_datasets`, `workspace_saved_views`, `user_workspace_state`, `workspace_viewer_profiles`). Later migrations add saved-view visibility, per-user last-view, and a proposed-views index (see [[saved-views]]).
- `bookmarks/` — server side of [[saved-views]]: `store.rs` (deep, `BookmarkStore` trait + SQLite + memory impls), `handlers.rs` (REST `/api/bookmarks/*` gated by `AuthPrincipal`), `routes.rs` (the bookmarks router builder), `broadcast.rs` (best-effort `BookmarkChanged` dispatch scoped by overlapping loaded datasets).
- `static_serve.rs` — SPA-asset router built around `tower-http::ServeDir`. `main.rs` reads `LUCIDA_WEB_DIST` (default `./lucida-web/dist`) and passes the resolved path in; this module only names the env var in its build-instructions landing-page text. Serves the bundle with index-fallback for client-routed deep links, or that landing page when the dist dir is missing. Mounted on the **public** router half (no auth wrap) so HTML/JS/CSS aren't 401'd; auth gates remain on `/auth/whoami` polling and `/api/*`. See [[decisions/0020-single-image-with-servedir]].

## Interactions

- **Inputs from clients**: `ClientMessage` (commands, presence, cursor, follow, dataset-open requests), `ChunkMessage::ChunkRequest`, legacy `AssetMessage::AssetRequest`, raw binary frames (peer-to-peer chunk relay format).
- **Outputs to clients**: `ServerMessage` (snapshot, broadcasts, peer events, `DatasetOpened`, `OpenDatasetFailed`, `GeneratedAvailabilityUpdate`, `GeneratedChunkStatus`, legacy `AssetCatalogUpdate`), binary chunk frames (`[client_id u32 LE][key_len u16 LE][key][bytes]`), and legacy binary proxy frames (same envelope + 64-byte `lucida_proxy::ProxyHeader` + voxels).
- **Auth gate**: every non-`/auth/*` route runs through middleware that extracts an `AuthPrincipal` from the `lucida_session` cookie. Public routes (`/auth/start`, `/auth/callback`, `/auth/error`, `/auth/dev/login` in dev) live in a separate router half. See [[auth]].
- **Dependencies**: [[lucida-core]] for the Scene/document model, [[lucida-content]] for `DatasetManifest`, [[lucida-protocol]] for wire types, [[lucida-store]] for storage backends and import, [[lucida-proxy]] for the proxy fallback path. `object_store` for cloud abstraction. `axum`, `tokio`, `tokio-tungstenite` for the network stack. `sqlx` (sqlite), `jsonwebtoken`, `reqwest` for auth.

## Workspace Admin Support

The v0 support surface is intentionally API-only and explicit. Lucida admins use `/admin/workspaces` routes rather than a broad admin dashboard:

- `GET /admin/workspaces?q=<text>&include_archived=true&limit=25` searches by workspace id/name, creator email, or member email and returns limited metadata, member count, owner count, dataset count, link settings, and archive state.
- `GET /admin/workspaces/:id` returns the same metadata plus ordered member summaries without adding the admin as a workspace member.
- `POST /admin/workspaces/:id/archive` and `POST /admin/workspaces/:id/restore` use the normal archive/restore storage path; archive also broadcasts `workspace_archived` and drops the live workspace.
- `POST /admin/workspaces/:id/owners` with `{"email":"user@example.com","display_name":"User"}` adds or promotes an owner, including for archived or orphaned workspaces. It never removes or demotes owners, so the normal last-owner invariant remains intact.

## Invariants

- **Document commands are sequenced and acked; presence updates are not.** Sender of a command receives `ServerMessage::Ack`; everyone else receives `ServerMessage::CommandBroadcast`. Both carry the same `seq`.
- **Workspace access is resolved by explicit membership before link access.** Owners manage members and link settings. Explicit members may be viewer/editor/owner; anyone-with-link may grant viewer/editor only. Link-shared workspaces are openable by URL but are not globally listed for every signed-in user.
- **Workspace recents and pins are personal state.** `user_workspace_state` records a principal's last-opened timestamp and personal pin. It does not grant access; list APIs only include link-derived state while the workspace still allows anyone-with-link access.
- **Archived workspaces are durable but inaccessible.** Archive sets `workspaces.archived_at`, removes the workspace from normal lists, denies new HTTP/WS opens, denies document mutations via the normal role checks, and broadcasts `workspace_archived` to connected clients before dropping the live workspace from the manager map. Restore clears `archived_at`; it does not delete or recreate document, dataset, member, saved-view, or user-state rows.
- **Live workspace eviction only drops runtime state.** `LUCIDA_WORKSPACE_IDLE_TTL_SECS` (default 3600) and `LUCIDA_WORKSPACE_IDLE_SWEEP_SECS` (default 60) control idle live-workspace cleanup. Eviction requires zero connected clients, cancels workspace-scoped background mutation paths, shuts down generated-coarse workers, and removes only the in-memory `LiveWorkspace`; SQLite workspace rows, dataset-source memberships, saved views, permissions, proxy cache, and generated-coarse cache remain reusable on lazy reopen.
- **Dataset source identity and workspace layer identity are split.** The legacy/global session path still uses a URL-derived `DatasetId` (`ds-{hex}` from the normalized canonical URL). Workspace sessions use a random opaque workspace-local `DatasetId` (`wds-*`) in document/runtime state, while `dataset_source_id` remains URL-derived for source membership dedupe and generated/cache reuse across workspaces. The helpers (`dataset_id_for_url`, `dataset_url_hash16`) live in [[lucida-content]]'s `url` module per [[decisions/0042-canonical-dataset-url-form]].
- **`u64::MAX` is the sentinel sender for server-originated broadcasts.** Used for `DatasetOpened` so the requesting client also receives a `CommandBroadcast` (not an `Ack`) — the client never applied the command locally and needs the broadcast path.
- **Self-presence is filtered server-side.** The outbound loop checks `sender == id` and drops presence/cursor/peer-joined messages back to their originator. Only `CommandBroadcast` is rewritten to `Ack` for the sender; everything else is silently filtered.
- **Per-client unicast routes** for chunk/status/proxy delivery live in `unicast_routes: HashMap<ClientId, mpsc::UnboundedSender<Message>>`. The first 4 bytes of every binary frame are the `client_id` so the relay can route without parsing.

## Gotchas

- **Open-dataset is async-spawned**, not awaited inline. The handler returns immediately; a background task does the import and broadcasts when ready. A second open of the same URL during the first import races on the binding map; `handle_open_remote_dataset` re-checks the binding presence under the session lock (via `find_loaded_binding`) and, if it lost the race, drops its duplicate binding/command and rebroadcasts the canonical `DatasetOpened` event instead. The re-check/rebroadcast is in the body of `handle_open_remote_dataset` (handler.rs).
- **Generated coarse cache directories are keyed by 16-byte URL hash** (`lucida_content::url::dataset_url_hash16` over the canonical URL form), not `DatasetId`. The hash is the same BLAKE3 prefix used for `DatasetId` so reopen can recover ready derived chunks for the same source URL across spelling variants.
- **Generated coarse fill is best-effort.** Background work warms coarse chunks, but visible requests and viewer-interest reprioritization drive correctness. Pending chunks surface as generated status messages, not timeouts.
- **Storage compression is detected once at import** by [[lucida-store]]'s `codec::parse_codec_chain` and assumed uniform across levels; the server only consumes the result. If a dataset uses different compression at different LODs, this assumption breaks silently.
- **Persistent state lives in SQLite** (`lucida.db` + `.db-shm` + `.db-wal`). Holds login sessions and pending OAuth states ([[auth]]); bookmarks + their indexed dataset side-table ([[saved-views]]). `LUCIDA_DB_PATH` configures the path; default is CWD-relative — set to an absolute path in production. See [[gotchas/oss-config-defaults]].
- **`PRAGMA foreign_keys` is per-connection.** SQLite cascades only fire when this PRAGMA is on, and sqlx doesn't enable it by default per pool connection. The bookmarks store does explicit two-table delete inside a transaction (belt-and-braces); the FK in the migration is documentation more than enforcement. Same caveat applies to any future SQLite-backed feature.
