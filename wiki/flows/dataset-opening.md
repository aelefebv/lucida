---
created: 2026-04-18
modified: 2026-05-07
---

# Flow: Dataset Opening

From "user pastes a URL" to "first chunks render." Crosses [[lucida-web]], [[lucida-server]], and [[lucida-store]]; involves WASM ingestion, JS-side fetch pipeline setup, planning, fetching, decoding, GPU upload, and the first render.

## Trace

1. **UI input** — user types/pastes a URL into the open-dataset input. `App.tsx` captures it; `useDatasets.handleUrlSubmit` calls `Bridge.sendOpenRemoteDataset(url)`.
2. **Wire**: `{type: "open_remote_dataset", url}` JSON to the WebSocket.
3. **Server** ([[lucida-server]] `handler.rs::handle_open_remote_dataset`):
   1. Compute `dataset_id` from URL hash (BLAKE3 → `ds-{16 hex}`). If a `ServerBinding` already exists for this URL, **rebroadcast the canonical `DatasetOpened` and return** (cache the import work).
   2. Otherwise, `lucida_store::backend::open(url)` → `Arc<dyn ObjectStore>`.
   3. `lucida_store::import::import_dataset(...)` → `ImportResult { manifest, fetch, binding_seed }`.
   4. Build `AssetCatalog` from entities (Wells advertise `WellProxy3D`; Fields and bare Images advertise `FieldProxy3D`).
   5. Build `ServerBinding` (resolver, cache, proxy cache, proxy generator) and insert into `Session::server_bindings`.
   6. `Session::apply(DocumentCommand::DatasetOpened(...))` → `seq` increments.
   7. Broadcast `ServerMessage::CommandBroadcast { seq, command }` to **all** clients (including the requester — sender sentinel `u64::MAX` so no client receives an `Ack`).
   8. Spawn background pre-generation: build `(T=0, C=0)` proxies for every advertised entity at lowest priority. Best-effort; failures logged.
4. **Client receives `command_broadcast`** ([[lucida-web]] `useBridge`):
   - **WASM hand-off**: `wasmScene.apply_command(commandJson)`. Scene's `apply` matches `DocumentCommand::DatasetOpened`, builds derived state (positions, projected geometry), bumps `epochs.content` and `epochs.layout`, initializes `dataset_settings` with default `ChannelSettings` per channel.
   - **JS hand-off** (`setupFetchPipeline`, six steps in order):
     1. `contentSource.registerImage(image_id, wire_format)` per image
     2. `datasetsRef.set(datasetId, {manifest, fetch})`
     3. `initLayerMaps(datasetId)`
     4. `set_channel_visible` per channel
     5. `loopRef.current.addDataset(datasetId, manifest)` and flip `interactiveDirty=true`
     6. Pre-allocate `Uint16Array` for the coarsest level
5. **Next RAF tick** ([[chunk-pipeline]]):
   1. Orchestrator's `planAndFetch` runs because `interactiveDirty`.
   2. WASM `view_query(dsId)` returns visible entities with `projected_diagonal_px` and `idealTargetLod`.
   3. [[planning-domain]] decides per-well mode (proxy / fallback / detail), enumerates wanted chunks with priorities.
   4. [[cpu-cache]] `submit(plan)` queues unique requests.
   5. Up to ~9 fetches launch via `contentSource.fetch(req)` → server.
6. **Server serves chunks** (`handler.rs::serve_chunk_from_store`): `cache.get_bytes` → decode storage compression → binary frame `[client_id u32 LE][key_len u16 LE][key][bytes]` to the requesting client's unicast channel.
7. **Client receives binary frame** (`bridge.ts::handleBinary`): routes by key prefix — chunk frames go to `contentSource.fetch` resolvers; proxy frames go to a separate proxy promise table.
8. **Decode pool** — 3 workers running `decode.worker.ts` decompress (Raw/Lz4/Zstd) into typed arrays.
9. **Cache insertion** — chunk lands in `cpuCache.ready[]`.
10. **Drain** (next tick): orchestrator pulls from `ready[]` within the 16 MB upload budget, filters against `workerWantedSet`, posts `sliceChunkData` or `volumeChunkData` to the GPU worker.
11. **Worker** ([[gpu-residency]]): writes atlas slot, updates indirection buffer, recomputes wanted-set, posts `wantedSetDelta` back to main.
12. **Render** — slice or volume shader runs, descriptor → indirection → atlas sample → fallback chain → contrast/gamma/LUT → opacity. Pixels.

## Where things can hang

- **Server-side import** (step 3.iii) — for slow object stores or many wells, can take seconds. The handler is `tokio::spawn`'d so the connection stays responsive; the client sees nothing until the broadcast arrives.
- **Pre-generation backlog** (step 3.viii) — proxies start landing within seconds for small plates, longer for large ones. Detail chunks are independent and arrive in parallel.
- **First chunk to GPU** (steps 5–10) — typical first-frame time is one RAF + one network round-trip + one decode + one upload, so on the order of 50–100 ms after `dataset_opened`.

## Idempotency

A second `open_remote_dataset` for the same URL is **fast** — the server's URL-hash check finds the existing `ServerBinding` and rebroadcasts the canonical `DatasetOpened` without re-importing. The client may see a duplicate `command_broadcast`; `Scene::apply` for `DatasetOpened` re-applies but `dataset_settings.entry(...).or_insert_with(...)` preserves user-set channel settings.

## Why "remote"?

The wire command is named `open_remote_dataset` even though the URL can already point to a local-to-the-server path (`lucida-store/src/backend.rs::open` routes `/path/...` and `file://` to `LocalFileSystem`). "Remote" here means *remote-from-the-browser* — the browser cannot read bytes itself, so it always asks the server.

The name is forward-looking: [[decisions/0006-content-source-vs-fetch-source|FetchSource]] reserves a `Local` variant for a future browser-side path (OPFS, File System Access API, drag-drop) where bytes never traverse the server. If that lands, the sibling command would be `OpenLocalDataset`. Until then, every dataset goes through this flow regardless of where the bytes live.

## Related

- [[chunk-pipeline]] — every step from planning forward
- [[decisions/0011-dual-handoff-on-dataset-opened]] — why WASM and JS both consume the event
- [[decisions/0005-three-output-import-model]] — the `ImportResult` shape
- [[lucida-server]]
- [[lucida-store]]
