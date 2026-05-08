---
created: 2026-04-18
modified: 2026-05-08
---

# lucida-server

Tokio + Axum WebSocket relay. Brokers multi-client sessions, sequences shared document commands, broadcasts presence, opens datasets via [[lucida-store]], serves chunks from a `CachedStore`, and (S4+) generates and serves on-demand proxy assets via [[lucida-proxy]].

## Why a relay, not a peer-mesh

Lucida is collaborative: many viewers can see the same dataset and follow each other. The server exists for two reasons:

1. **Document-state arbitration.** Each `DocumentCommand` (e.g. `DatasetOpened`) gets a monotonically increasing `seq` and an `Ack` to the sender. New clients receive a `Snapshot` of the full document state on connect. This makes "what datasets are loaded" a single authoritative fact.
2. **Storage proxy and chunk router.** Browsers can't realistically open arbitrary `gs://` / `s3://` Zarr stores directly with credentials. The server probes the store, builds a [[lucida-content|DatasetManifest]], and on demand fetches/decodes chunks and forwards them as binary frames to the requesting client. The bytes the client sees are pre-decompressed (Lz4/Zstd → raw), keyed by `(dataset_id, image_id, chunk_key)`.

Presence (cursor, viewport, follow) doesn't need arbitration — it's broadcast through the same WebSocket but never sequenced or persisted. See [[decisions/0001-document-vs-viewport-split]].

## Module map

- `lib.rs` — `AppState`, `BroadcastItem` (the in-process pub/sub envelope), `ProxyConfig`
- `main.rs` — Axum server entry point; wires WebSocket handler, admin routes, and the two-router split for [[auth]]
- `handler.rs` — per-client connection loop: snapshot → broadcast subscribe → inbound dispatch (`ClientMessage` / `ChunkMessage` / `AssetMessage` / binary chunk relay)
- `session.rs` — `Session` state: `DocumentState` + history ring buffer + per-client `PresenceState` + `server_bindings: HashMap<DatasetId, ServerBinding>`
- `binding.rs` — `ServerBinding`, `ChunkResolver`, `StorageCompression` detection from Zarr v3 codec chain
- `decode.rs` — Lz4/Zstd → raw decode, shared between chunk-serve and proxy generation
- `proxy/` — server-side proxy infrastructure: `ProxyCache` (per-dataset on-disk cache), `ProxyGenerator` (bounded-concurrency, in-flight dedup), `ServerProxySource` (adapter from `CachedStore` to `lucida-proxy`'s sync trait)
- `auth/` — Google OAuth + session cookies + admin allowlist + cleanup sweep + audit logging. See [[auth]] for the deep-dive.
- `browse.rs` / `admin.rs` — HTTP routes for filesystem browsing and admin operations (e.g. clear proxy cache)
- `migrations/` — versioned SQL migrations applied at startup (sqlx). First persistent state in the server.

## Interactions

- **Inputs from clients**: `ClientMessage` (commands, presence, cursor, follow, dataset-open requests), `ChunkMessage::ChunkRequest`, `AssetMessage::AssetRequest`, raw binary frames (peer-to-peer chunk relay format).
- **Outputs to clients**: `ServerMessage` (snapshot, broadcasts, peer events, `DatasetOpened`, `OpenDatasetFailed`, `AssetCatalogUpdate`), binary chunk frames (`[client_id u32 LE][key_len u16 LE][key][bytes]`), binary proxy frames (same envelope + 64-byte `lucida_proxy::ProxyHeader` + voxels).
- **Auth gate**: every non-`/auth/*` route runs through middleware that extracts an `AuthPrincipal` from the `lucida_session` cookie. Public routes (`/auth/start`, `/auth/callback`, `/auth/error`, `/auth/dev/login` in dev) live in a separate router half. See [[auth]].
- **Dependencies**: [[lucida-core]] for the Scene/document model, [[lucida-content]] for `DatasetManifest`, [[lucida-protocol]] for wire types, [[lucida-store]] for storage backends and import, [[lucida-proxy]] for the synchronous proxy generation algorithm. `object_store` for cloud abstraction. `axum`, `tokio`, `tokio-tungstenite` for the network stack. `sqlx` (sqlite), `jsonwebtoken`, `reqwest` for auth.

## Invariants

- **Document commands are sequenced and acked; presence updates are not.** Sender of a command receives `ServerMessage::Ack`; everyone else receives `ServerMessage::CommandBroadcast`. Both carry the same `seq`.
- **`DatasetId` is content-derived from the source URL** (BLAKE3 of URL, first 8 bytes → `ds-{hex}`). Two opens of the same URL within a session reuse the existing `ServerBinding` and rebroadcast the canonical `DatasetOpened` instead of re-importing. See `dataset_id_for_url` in `handler.rs`.
- **`u64::MAX` is the sentinel sender for server-originated broadcasts.** Used for `DatasetOpened` so the requesting client also receives a `CommandBroadcast` (not an `Ack`) — the client never applied the command locally and needs the broadcast path.
- **Self-presence is filtered server-side.** The outbound loop checks `sender == id` and drops presence/cursor/peer-joined messages back to their originator. Only `CommandBroadcast` is rewritten to `Ack` for the sender; everything else is silently filtered.
- **Per-client unicast routes** for chunk/proxy delivery live in `unicast_routes: HashMap<ClientId, mpsc::UnboundedSender<Message>>`. The first 4 bytes of every binary frame are the `client_id` so the relay can route without parsing.

## Gotchas

- **Open-dataset is async-spawned**, not awaited inline. The handler returns immediately; a background task does the import and broadcasts when ready. A second open of the same URL during the first import races on the binding map; `handle_open_remote_dataset` re-checks the binding presence under the lock and rebroadcasts the canonical event if it lost the race. See `handler.rs:594-619`.
- **Proxy cache directories are keyed by 16-byte URL hash**, not `DatasetId`. The hash is the same BLAKE3 prefix used for `DatasetId` so the two stay in lockstep — see the comment on `dataset_url_hash16`.
- **Pre-generation on dataset open is best-effort.** S5 spawns a background task to pre-build `(T=0, C=0)` proxies for every advertised entity. Failures are logged and dropped — the open succeeds either way; client-side fetches will surface the failure on their own path.
- **Storage compression is detected from the codec chain** at level 0 only and assumed uniform across levels. If a dataset uses different compression at different LODs, this assumption breaks silently.
- **First persistent state in the server.** SQLite database (`lucida.db` + `.db-shm` + `.db-wal`) holds login sessions, pending OAuth states, and (PRD #454) bookmarks. `LUCIDA_DB_PATH` configures the path; default is CWD-relative — set to an absolute path in production. See [[gotchas/oss-config-defaults]].
