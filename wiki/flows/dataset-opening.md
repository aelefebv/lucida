---
type: Flow
title: "Flow: Dataset Opening"
description: "From \"user pastes a URL\" to \"first chunks render.\" Crosses lucida-web, lucida-server, and lucida-store; involves WASM ingestion, JS-side fetch pipeline setup, planning, fetching, decoding, GPU upload, and the first re…"
tags: [lucida, flow]
source_path: wiki/flows/dataset-opening.md
created: 2026-04-18
modified: 2026-07-16
---

# Flow: Dataset Opening

From "user pastes a URL" to "first chunks render." Crosses [lucida-web](../systems/crates/lucida-web.md), [lucida-server](../systems/crates/lucida-server.md), and [lucida-store](../systems/crates/lucida-store.md); involves WASM ingestion, JS-side fetch pipeline setup, planning, fetching, decoding, GPU upload, and the first render.

## Trace

1. **UI input** — user types/pastes a URL into the open-dataset input. `App.tsx` captures it; `useDatasets.handleUrlSubmit` calls `Bridge.sendOpenRemoteDataset(url)`.
2. **Wire**: `{type: "open_remote_dataset", url}` JSON to the WebSocket.
3. **Server** ([lucida-server](../systems/crates/lucida-server.md) `dataset_open.rs::open_dataset`, reached through the thin websocket adapter in `handler.rs`):
   1. Admit the source through `SourceIdentity`, which owns the canonical locator and its full BLAKE3 identity (`ds-{64 hex}`). Emit request-correlated `dataset_open_progress` diagnostics. The client-facing workspace id (`wds-{uuid}`, what peers address) is minted separately via `new_workspace_dataset_id`.
   2. Open the admitted source as an `Arc<dyn ObjectStore>`. Remote sources use the standard backend router. Local server sources retain the descriptor-confined `AdmittedLocalDataset` capability created by `SourceTrustPolicy`; they are never reopened through the trusted ambient-filesystem entry point.
   3. `lucida_store::import::import_dataset(...)` → `ImportResult { manifest, fetch, binding_seed, source_revision }`. The semantic revision fingerprints the imported source generation independently of its locator identity.
   4. Validate the manifest and its live chunk fetch descriptor as one registration unit.
   5. Plan generated coarse levels for images that lack a usable source coarse level. Register each plan with the derived cache; recovered ready chunks become initial generated availability deltas.
   6. Compare the resulting `SourceVersion { identity, revision }` with the live binding. An exact generation reuses its resources; a changed revision builds a revision-scoped resolver, source cache, derived-chunk cache, and generated-coarse scheduler. Persist the staged replacement first. After persistence succeeds, hold the session lock while aborting and joining the old generated service, then reset generated availability and swap the binding. If persistence fails, the old binding and service remain authoritative and live. Workspace background drain installs a cancellation marker before it snapshots bindings; the open rechecks that marker at publication and before starting its service, so a service constructed too late for the drain snapshot is shut down instead of escaping into the session.
   7. `Session::apply(DocumentCommand::DatasetOpened(...))` → `seq` increments.
   8. Apply and broadcast `GeneratedAvailabilityUpdate` when generated coarse metadata/readiness exists.
   9. Broadcast `ServerMessage::CommandBroadcast { seq, command }` to **all** clients (including the requester — sender sentinel `u64::MAX` so no client receives an `Ack`).
   10. Enqueue best-effort background generated-coarse fill.
4. **Client receives `command_broadcast`** ([lucida-web](../systems/crates/lucida-web.md) `useBridge`):
   - **WASM hand-off**: `wasmScene.apply_command(commandJson)`. Scene's `apply` matches `DocumentCommand::DatasetOpened`, builds derived state (positions, projected geometry), bumps `epochs.content` and `epochs.layout`, initializes `dataset_settings` with default `ChannelSettings` per channel.
   - **JS hand-off** (`setupFetchPipeline`, six steps in order):
     1. `contentSource.registerImage(image_id, wire_format)` per image
     2. `datasetsRef.set(datasetId, {manifest, fetch})`
     3. `initLayerMaps(datasetId)`
     4. **Grow per-channel settings**: when `channelCount > 1`, apply a single `set_channel_visible` for the *last* channel only — this grows the per-channel settings vec via `ensure_channel` (the `DatasetOpened` apply may have created just one channel setting; the real channel count lives in the data shape). Not a per-channel loop.
     5. `loopRef.current.addDataset(datasetId, manifest)` (which itself flips `interactiveDirty=true`), then `bumpDatasetsVersion()`
   - **Generated availability** is merged by a *separate* async handler (`applyGeneratedAvailabilityDelta` / `applyGeneratedAvailabilitySnapshots`), driven by `onGeneratedAvailabilityUpdate` and the open-time snapshot — not one of `setupFetchPipeline`'s steps. It folds readiness deltas into the client-side generated availability catalog as they arrive.
5. **Next RAF tick** ([Flow: Chunk Lifecycle](chunk-lifecycle.md)):
   1. TickCoordinator's `planAndFetch` runs because `interactiveDirty`.
   2. WASM `view_query(dsId)` returns visible entities with `projected_diagonal_px` and `idealTargetLod`.
   3. [Planning Domain](../systems/subsystems/planning-domain.md) resolves explicit detail/coarse levels per tile/image and enumerates tier-labeled wanted chunks with priorities.
   4. [CPU Cache](../systems/subsystems/cpu-cache.md) `submit(plan)` queues unique requests.
   5. Fetches launch via `contentSource.fetch(req)` → server, bounded by `decode-pool-size × 3` and 32 MB in-flight.
6. **Server serves chunks**:
   - Source level request: `serve_chunk_from_store` uses `CachedStore`, decodes storage compression, and sends a normal chunk frame.
   - Generated coarse request: if bytes are ready, `serve_generated_chunk_request` sends the same normal chunk frame. If not, it sends `GeneratedChunkStatus` (`pending`, `failed_*`, or `unavailable`) so the client does not wait for a timeout.
7. **Client receives frame/status** (`bridge.ts::handleBinary` and `GeneratedChunkStatus` handlers): normal chunk frames resolve `contentSource.fetch`; generated `pending` is treated as non-failure and retried after later readiness.
8. **Decode pool** — a dynamically-sized worker pool (`Math.max(2, floor(cores/2) - 1)`) running `decode.worker.ts` decompresses (Raw/Lz4/Zstd) into typed arrays.
9. **Cache insertion** — chunk lands in CpuCache with priority and wanted-generation metadata.
10. **Upload** (next tick): the uploader walks `cpuCache.getDeliverable()` within the 8 MB main-view upload budget and posts `sliceChunkData` or `volumeChunkData` to the GPU worker.
11. **Worker** ([GPU Residency](../systems/subsystems/gpu-residency.md)): writes atlas slot, updates indirection buffer, recomputes wanted-set, posts `wantedSetDelta` back to main.
12. **Render** — slice or volume shader runs, descriptor → explicit detail/coarse tier source → indirection → atlas sample → fallback chain → contrast/gamma/LUT → opacity. Pixels.

## Where things can hang

- **Server-side import** (step 3.iii) — for slow object stores or many groups, can take seconds. The handler is `tokio::spawn`'d so the connection stays responsive; clients receive request-correlated `dataset_open_progress` messages before the final success/failure.
- **Generated coarse backlog** (step 3.x) — generated coarse chunks may be advertised before bytes are ready. Detail chunks are independent and arrive in parallel; pending generated chunks surface as status messages and later readiness deltas.
- **First chunk to GPU** (steps 5–10) — typical first-frame time is one RAF + one network round-trip + one decode + one upload, so on the order of 50–100 ms after `dataset_opened`.

## Idempotency

A second `open_remote_dataset` for the same locator re-imports enough metadata to establish its semantic revision. Matching `SourceVersion`s reuse the live generation; a changed revision replaces document and runtime binding atomically after durable persistence. The old generated worker is quiesced before the new availability state is published, and generated deltas are additionally accepted only from the cache owned by the current binding. Source and generated-coarse caches are scoped by full locator identity plus revision, so stale bytes and stale Ready updates cannot cross generations. `Scene::apply` treats server-authored `DatasetOpened` as an upsert while preserving per-dataset settings; client-authored `DatasetOpened` commands are rejected at the boundary.

## Why "remote"?

The wire command is named `open_remote_dataset` even though the URL can already point to a local-to-the-server path. `SourceTrustPolicy` admits such paths beneath an operator-configured root and opens them through a descriptor-confined capability. The separate `lucida-store::backend::open` library/Python entry point routes trusted local paths to `LocalFileSystem`. "Remote" here means *remote-from-the-browser* — the browser cannot read bytes itself, so it always asks the server.

The name is forward-looking: [FetchSource](../decisions/0006-content-source-vs-fetch-source.md) reserves a `Local` variant for a future browser-side path (OPFS, File System Access API, drag-drop) where bytes never traverse the server. If that lands, the sibling command would be `OpenLocalDataset`. Until then, every dataset goes through this flow regardless of where the bytes live.

## Related

- [Flow: Chunk Lifecycle](chunk-lifecycle.md) — every step from planning forward
- [Flow: Dataset Diagnostics](dataset-diagnostics.md) — browser/CLI/Python/server-log diagnostics for open, health, restore, cache, and failure behavior
- [Dual Hand-off on DatasetOpened (WASM + JS)](../decisions/0011-dual-handoff-on-dataset-opened.md) — why WASM and JS both consume the event
- [Three-Output Import Model](../decisions/0005-three-output-import-model.md) — the `ImportResult` shape
- [lucida-server](../systems/crates/lucida-server.md)
- [lucida-store](../systems/crates/lucida-store.md)
