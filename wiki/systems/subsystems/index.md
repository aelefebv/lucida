# Subsystems

Web-internal modules and cross-cutting runtime concepts. These live inside `lucida-web/src/` (or span `lucida-web` + `lucida-server`, like the chunk pipeline) and are runtime-architecture concepts, not crates.

Start with [Chunk Lifecycle](../../flows/chunk-lifecycle.md) for the end-to-end path from dataset URL to pixels.

## The chunk pipeline

- [Planning Domain](planning-domain.md) — wanted-set computation, detail/coarse tier selection, lane-based priority formula
- [CPU Cache](cpu-cache.md) — sole chunk fetch path; tiered LRU eviction; decode pool dispatch; drain to GPU
- [Generated Coarse](generated-coarse.md) — server-managed derived coarse pyramid levels served through the normal chunk path
- [Upload Pipeline](upload-pipeline.md) — `pipeline/upload/` Uploader; cold/hot state emission, drain/resend/dispatch, delivery tracking, worker feedback
- [GPU Residency](gpu-residency.md) — tiered chunk atlases (slice/volume), indirection, descriptor buffer, semantic fallback chain
- [Worker Protocol](worker-protocol.md) — typed `postMessage` contract for cold/hot/delta state between main thread and GPU worker
- [Scene State and Epochs](scene-state-and-epochs.md) — typed epoch counters drive the tick coordinator's frame fast-path
- [Minimap](minimap.md) — separate low-resolution spatial context path with its own lane and resources

## Scene, layout, and display

- [Layout System](layout-system.md) — registered layouts, `SetActiveLayout`, derived placement rebuilds
- [Multi-Channel and Colormaps](multichannel-and-colormaps.md) — per-channel state, 15 LUTs, composite key naming
- [Camera and Navigation](camera-and-navigation.md) — `Slice`/`Arcball`/`Fly` camera models in `lucida-core` plus the web input layer (keybinding registry, RAF loops, mode/focal-depth UI)
- [Debug overlays & diagnostics UI](debug-overlays.md) — in-app developer surface in `lucida-web/src/debug/`: on-canvas overlays, FPS readout, tabbed config/telemetry panel, `window` globals for headless capture

## Collaboration, persistence, and auth

- [Saved Views](saved-views.md) — `#view=…` URL-as-app-state + server-stored `#b=<id>` bookmarks; spans `lucida-core` (schema), `lucida-web` (encoder/applier/sidebar), `lucida-server` (SQLite store + REST + broadcast)
- [Workspaces](workspaces.md) — server-stored container of opened datasets, saved views, and members; the unit of collaboration and of the live session (`/ws/workspaces/:id`); `wds-` membership vs `ds-` source identity
- [Presence and Follow Mode](presence-and-follow-mode.md) — peer-to-peer presence, transitive follow chains, throttling
- [Annotations, comments, and mentions](annotations.md) — point/line/box pins with comment threads and `@mention`s; authoritative state in `lucida-core`, persistence/broadcast in `lucida-server`, overlays/inbox in `lucida-web`
- [Authentication](auth.md) — backend-mediated Google OAuth + httpOnly session cookies; `PrincipalExtractor` trait is the OSS provider extension point
- [Deployment](deployment.md) — single-image container shape, env-var contract, persistence model, OAuth + data-backend identity per cloud, Ingress / WebSocket tuning, release flow. Conceptual companion to `extras/deploy/RUNBOOK.md`.
