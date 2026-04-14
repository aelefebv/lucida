# Lucida Architecture

Multi-client volumetric microscopy viewer. Rust core shared across web (WASM), CLI, Python (PyO3), and server.

## Workspace

```
lucida-content/    Canonical content model (entities, images, layouts, transforms)
lucida-protocol/   Fetch descriptors + registration types (Proxied/Direct/Local)
lucida-core/       Scene state, commands, epochs, geometric queries, ray picking, VisibleRegion (WASM + native)
lucida-store/      Storage abstraction, OME-Zarr parsing, import pipeline
lucida-server/     Tokio WebSocket server, session management, chunk serving
lucida-cli/        CLI client (inspection + control)
lucida-web/        React + WebGPU frontend (not in Cargo workspace)
                     pipeline/planning.ts  — Planning domain: pure function PlanningSnapshot → RequestPlan
lucida-py/         Python bindings via PyO3 (excluded from workspace, built with maturin)
```

## Crate Dependency Graph

```
                lucida-content          (standalone, serde only)
                  ↑       ↑
           ┌──────┘       └──────┐
      lucida-protocol            │
        ↑       ↑                │
   ┌────┘       └────┐           │
lucida-core      lucida-store ───┘
   ↑                ↑
   └──┐         ┌───┘
    lucida-server
```

`lucida-core` and `lucida-store` are siblings — neither depends on the other. `lucida-server` is where they converge.

## Data Flow: Import Pipeline

```
OME-Zarr file/URL
  → lucida-store::backend::open()           ObjectStore handle
  → lucida-store::import::import_dataset()  ImportResult
      ├── ContentGraph                       canonical dataset description
      ├── ClientFetchDescriptor              how clients fetch chunks
      └── ServerBindingSeed                  server-private storage metadata
  → lucida-server::binding::ChunkResolver   compiled key→path mapper
```

## Data Flow: Runtime

```
Client sends OpenRemoteDataset { url }
  → Server: open store, import_dataset → ImportResult
  → Server: build ServerBinding (ChunkResolver + CachedStore)
  → Server: broadcast RegisterDataset { content, fetch } to all clients
  → Client: apply RegisterDataset to scene state (builds derived indices)
  → Client: use ClientFetchDescriptor to set up fetch pipeline

Chunk request:
  → Client sends { dataset_id, image_id, key }
  → Server: ChunkResolver.resolve(image_id, key) → object store path
  → Server: read, decompress (WireFormat::Raw), send bytes

Planning cycle (web only, wired in step 7/Orchestrator):
  → WASM: view_query() → ViewQueryResult (per-entity visibility, LOD, importance)
  → WASM: visible_region() → VisibleRegion (viewport AABB, frustum planes)
  → Orchestrator: assemble PlanningSnapshot from upstream domains
  → plan(snapshot) → RequestPlan (prioritized chunk requests, active set, epochs)
  → Orchestrator: feed RequestPlan to CPU Cache for fetching
  → CpuCache: fetch via ContentSource, decode via DecodePool, cache decoded buffers
  → Orchestrator: drain ready deliveries from CpuCache, send to worker
  → Orchestrator: re-send evicted-but-cached chunks via getCached()

Worker protocol (main thread → GPU worker):
  → Atlas config messages carry PlanningEpochs (establish worker's "current" epoch)
  → Chunk data messages carry PlanningEpochs (epoch data was fetched under)
  → Worker compares delivery epochs against current: drops stale batches
  → Staleness = delivery.selectionEpoch < current or delivery.contentEpoch < current
  → Stale drops reported back as "skipped" via chunksEvicted message
```

## Per-Crate Architecture Docs

- [lucida-content/ARCHITECTURE.md](lucida-content/ARCHITECTURE.md)
- [lucida-protocol/ARCHITECTURE.md](lucida-protocol/ARCHITECTURE.md)
- [lucida-store/ARCHITECTURE.md](lucida-store/ARCHITECTURE.md)
- [lucida-server/ARCHITECTURE.md](lucida-server/ARCHITECTURE.md)

## Related

- [DOMAINS.md](DOMAINS.md) — full domain model, cross-domain rules, pipeline architecture
- [docs/canonical-content-graph.md](docs/canonical-content-graph.md) — canonical content graph documentation
- [docs/import-pipeline-spec.md](docs/import-pipeline-spec.md) — import pipeline specification
