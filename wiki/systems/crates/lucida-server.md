---
created: 2026-04-18
modified: 2026-05-26
---

# lucida-server

Tokio + Axum WebSocket relay. Brokers multi-client sessions, sequences shared document commands, broadcasts presence, opens datasets via [[lucida-store]], serves source chunks from a `CachedStore`, and generates/serves derived coarse chunks through the normal chunk path. The old proxy generator remains behind an explicit legacy bridge flag. Per [[decisions/0020-single-image-with-servedir]] it also serves the SPA bundle directly via `tower-http::ServeDir`, so the production deploy unit can be a single container image and a developer's local `:9876` can render the app without an extra reverse proxy.

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
- `binding.rs` — `ServerBinding`, `ChunkResolver`, `StorageCompression` detection from Zarr v3 codec chain
- `decode.rs` — Lz4/Zstd → raw decode, shared between source chunk serving and derived generation
- `generated.rs` — generated coarse planning, scheduling, cancellation, materialization, derived-cache recovery, and availability broadcasts
- `proxy/` — legacy server-side proxy infrastructure: `ProxyCache` (per-dataset on-disk cache), `ProxyGenerator` (bounded-concurrency, in-flight dedup), `ServerProxySource` (adapter from `CachedStore` to `lucida-proxy`'s sync trait)
- `auth/` — Google OAuth + session cookies + admin allowlist + cleanup sweep + audit logging. See [[auth]] for the deep-dive.
- `workspace.rs` — workspace records, membership/link sharing, authorization, lazy live-session restore, workspace-scoped document persistence, and REST/WebSocket routes under `/api/workspaces/*` and `/ws/workspaces/:id`.
- `browse.rs` / `admin.rs` — HTTP routes for filesystem browsing and admin operations (e.g. clear proxy cache). `browse_handler`'s `path` query param is optional per [[decisions/0042-canonical-dataset-url-form]]: when absent, the response is a platform-default root — drives list (`c:`, `d:`, ...) on Windows via an A-Z `tokio::fs::metadata` scan, `/` listing on Unix. Returned `path` field is always in canonical-display form (`\\?\` and `\\?\UNC\` prefixes stripped, drive letter lowercased, forward-slashified). `data_dir` security constraint still enforced via segment-aware `starts_with` on canonicalized PathBufs.
- `migrations/` — versioned SQL migrations applied at startup (sqlx). Persistent state grew with [[auth]] (`login_sessions`, `pending_auth`), [[saved-views]] (`bookmarks` + `bookmark_datasets`), and workspaces (`workspaces`, `workspace_members`, `workspace_dataset_sources`, `workspace_datasets`).
- `bookmarks/` — server side of [[saved-views]]: `store.rs` (deep, `BookmarkStore` trait + SQLite + memory impls), `handlers.rs` (REST `/api/bookmarks/*` gated by `AuthPrincipal`), `broadcast.rs` (best-effort `BookmarkChanged` dispatch scoped by overlapping loaded datasets).
- `static_serve.rs` — SPA-asset router built around `tower-http::ServeDir`. Reads `LUCIDA_WEB_DIST` (default `./lucida-web/dist`); serves the bundle with index-fallback for client-routed deep links, or a build-instructions landing page when the dist dir is missing. Mounted on the **public** router half (no auth wrap) so HTML/JS/CSS aren't 401'd; auth gates remain on `/auth/whoami` polling and `/api/*`. See [[decisions/0020-single-image-with-servedir]].

## Interactions

- **Inputs from clients**: `ClientMessage` (commands, presence, cursor, follow, dataset-open requests), `ChunkMessage::ChunkRequest`, legacy `AssetMessage::AssetRequest`, raw binary frames (peer-to-peer chunk relay format).
- **Outputs to clients**: `ServerMessage` (snapshot, broadcasts, peer events, `DatasetOpened`, `OpenDatasetFailed`, `GeneratedAvailabilityUpdate`, `GeneratedChunkStatus`, legacy `AssetCatalogUpdate`), binary chunk frames (`[client_id u32 LE][key_len u16 LE][key][bytes]`), and legacy binary proxy frames (same envelope + 64-byte `lucida_proxy::ProxyHeader` + voxels).
- **Auth gate**: every non-`/auth/*` route runs through middleware that extracts an `AuthPrincipal` from the `lucida_session` cookie. Public routes (`/auth/start`, `/auth/callback`, `/auth/error`, `/auth/dev/login` in dev) live in a separate router half. See [[auth]].
- **Dependencies**: [[lucida-core]] for the Scene/document model, [[lucida-content]] for `DatasetManifest`, [[lucida-protocol]] for wire types, [[lucida-store]] for storage backends and import, [[lucida-proxy]] only for the legacy proxy bridge. `object_store` for cloud abstraction. `axum`, `tokio`, `tokio-tungstenite` for the network stack. `sqlx` (sqlite), `jsonwebtoken`, `reqwest` for auth.

## Invariants

- **Document commands are sequenced and acked; presence updates are not.** Sender of a command receives `ServerMessage::Ack`; everyone else receives `ServerMessage::CommandBroadcast`. Both carry the same `seq`.
- **Workspace access is resolved by explicit membership before link access.** Owners manage members and link settings. Explicit members may be viewer/editor/owner; anyone-with-link may grant viewer/editor only. Link-shared workspaces are openable by URL but are not globally listed for every signed-in user.
- **Dataset source identity and workspace layer identity are split.** The legacy/global session path still uses a URL-derived `DatasetId` (`ds-{hex}` from the normalized canonical URL). Workspace sessions use a random opaque workspace-local `DatasetId` (`wds-*`) in document/runtime state, while `dataset_source_id` remains URL-derived for source membership dedupe and generated/cache reuse across workspaces. The helpers (`dataset_id_for_url`, `dataset_url_hash16`) live in [[lucida-content::url]] per [[decisions/0042-canonical-dataset-url-form]].
- **`u64::MAX` is the sentinel sender for server-originated broadcasts.** Used for `DatasetOpened` so the requesting client also receives a `CommandBroadcast` (not an `Ack`) — the client never applied the command locally and needs the broadcast path.
- **Self-presence is filtered server-side.** The outbound loop checks `sender == id` and drops presence/cursor/peer-joined messages back to their originator. Only `CommandBroadcast` is rewritten to `Ack` for the sender; everything else is silently filtered.
- **Per-client unicast routes** for chunk/status/proxy delivery live in `unicast_routes: HashMap<ClientId, mpsc::UnboundedSender<Message>>`. The first 4 bytes of every binary frame are the `client_id` so the relay can route without parsing.

## Gotchas

- **Open-dataset is async-spawned**, not awaited inline. The handler returns immediately; a background task does the import and broadcasts when ready. A second open of the same URL during the first import races on the binding map; `handle_open_remote_dataset` re-checks the binding presence under the lock and rebroadcasts the canonical event if it lost the race. See `handler.rs:594-619`.
- **Generated coarse cache directories are keyed by 16-byte URL hash** (`lucida_content::url::dataset_url_hash16` over the canonical URL form), not `DatasetId`. The hash is the same BLAKE3 prefix used for `DatasetId` so reopen can recover ready derived chunks for the same source URL across spelling variants.
- **Generated coarse fill is best-effort.** Background work warms coarse chunks, but visible requests and viewer-interest reprioritization drive correctness. Pending chunks surface as generated status messages, not timeouts.
- **Storage compression is detected from the codec chain** at level 0 only and assumed uniform across levels. If a dataset uses different compression at different LODs, this assumption breaks silently.
- **Persistent state lives in SQLite** (`lucida.db` + `.db-shm` + `.db-wal`). Holds login sessions and pending OAuth states ([[auth]]); bookmarks + their indexed dataset side-table ([[saved-views]]). `LUCIDA_DB_PATH` configures the path; default is CWD-relative — set to an absolute path in production. See [[gotchas/oss-config-defaults]].
- **`PRAGMA foreign_keys` is per-connection.** SQLite cascades only fire when this PRAGMA is on, and sqlx doesn't enable it by default per pool connection. The bookmarks store does explicit two-table delete inside a transaction (belt-and-braces); the FK in the migration is documentation more than enforcement. Same caveat applies to any future SQLite-backed feature.
