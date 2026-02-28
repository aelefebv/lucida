# Lucida Workflow Sequences

Version: 0.1 draft  
Date: 2026-02-28  
Status: First-pass workflow and sequence specification aligned to `spec.md` and `protocol_and_schemas.md`

## 1. Purpose

This document specifies the canonical runtime workflows for Lucida.

It translates the product spec and protocol/schema contracts into end-to-end sequences that can drive:
- engine implementation
- browser/Jupyter/CLI client implementation
- acceptance testing
- failure handling design
- ticket decomposition

Each sequence is written in an implementation-oriented style and includes:
- actors
- trigger
- preconditions
- ordered message flow
- state transitions
- data-plane behavior
- failure and edge cases
- invariants and test points

This document is normative for workflow behavior, but not for the exact transport library or internal engine implementation.

---

## 2. Actors and notation

### 2.1 Actors

- **User**: human operator interacting through browser, Jupyter, CLI, or another client.
- **Client**: Lucida frontend with WebGPU renderer and local caches.
- **Engine**: authoritative Lucida Engine.
- **Watcher**: source file/directory watcher subsystem inside the engine.
- **Builder**: ingest/build subsystem inside the engine that produces canonical cache and stream store assets.
- **Data Store**: central Lucida cache directory and any backing object/file store used to serve payloads.
- **Compute Client**: local or remote process that consumes a RegionRecipe/cutout and publishes derived chunks.

### 2.2 Message naming conventions

Control-plane messages use schema-aligned names such as:
- commands: `view.pan`, `scene.layer_add`, `cutout.create`, `publish.write_chunks`
- events: `scene.layer_upsert`, `source.generation_ready`, `metadata.filter_result_ready`

### 2.3 State notation

This document references the following authoritative state domains:
- `session`: session-level state (`session_rev`, lease, exposure mode)
- `shared_scene`: shared scene state (`scene_rev`, sources, datasets, layers, targets)
- `client_view[client_id]`: per-client view state (`view_rev`, camera, indices, per-client rendering overrides)
- `layer[layer_id]`: layer-local revisions (`layer_rev`, `metadata_rev`, `write_rev`)
- `source[source_id]`: source-local generation tracking (`generation_seq`, current `@working`)

### 2.4 General control-plane behavior

Unless stated otherwise:
- every command is acknowledged with `command_ack`
- every authoritative state change is communicated by one or more typed events
- clients MUST treat typed events as truth and MUST reconcile local predicted state to match
- clients MAY optimistically update local view state for responsiveness when the command scope is `client_view`

---

## 3. Cross-cutting invariants

The following invariants apply to all sequences.

### 3.1 Authority and reconciliation

1. The engine is authoritative.
2. Clients may predict only their own view-state updates.
3. Shared scene state must never be considered committed until the engine emits authoritative events.

### 3.2 Generation consistency

4. A rendered frame must never mix payloads from different generations of the same layer.
5. Refinement must occur only within a generation.
6. If a layer's current generation changes, in-flight requests from older generations must be canceled or discarded.

### 3.3 Lease and permissions

7. Shared scene edits require both a control token and the shared-scene lease.
8. Derived chunk publishing requires a control token but not the lease.
9. Per-client view-state changes never require the lease.

### 3.4 Reproducibility

10. Any exported Scene or Context Package must record the exact generation references in effect at the time of export.
11. Any derived layer computed at LOD > 0 must carry and surface a “computed at LODk” warning/indicator.

### 3.5 Sparse derived layers

12. Missing sparse derived chunks render as transparent/no contribution.
13. Publish conflict resolution is last-write-wins per chunk.
14. Publish batches are chunk-aligned only.

### 3.6 Metadata and labels

15. Label filtering operates over dense IDs, not original sparse IDs.
16. Metadata sidecar changes trigger automatic recompute of any active filter result for affected clients/layers.

---

## 4. Sequence 01: Client attach, snapshot, and capability handshake

### 4.1 Purpose

Attach a client to a session, establish its identity and permissions, send the authoritative snapshot, and negotiate rendering/decode capabilities.

### 4.2 Actors

- Client
- Engine

### 4.3 Trigger

A user opens the browser client, launches a Jupyter widget, or attaches via CLI/UI to an existing session.

### 4.4 Preconditions

- Session exists.
- Client has network access to the engine.
- If the session requires view tokens, the client presents a valid view token.
- If the client wants control permissions, it presents a valid control token.

### 4.5 Ordered flow

1. Client opens control-plane connection.
2. Client sends attach/auth handshake with:
   - client label
   - requested permission class
   - view token if needed
   - control token if present
   - capability advertisement:
     - supported codecs (`zstd`, `lz4`, etc.)
     - WebGPU limits
     - preferred CPU/GPU cache budgets
     - preferred FPS / quality hints
3. Engine validates tokens and classifies client permission level.
4. Engine allocates or confirms `client_id`.
5. Engine emits `session.client_joined` to other clients.
6. Engine sends `session.snapshot` containing:
   - `session`
   - `shared_scene`
   - `client_view[client_id]`
   - `permissions`
   - `lease_state`
   - `client_roster`
   - warnings in scope
7. Engine sends `permissions.updated` if the permission class has been narrowed or adjusted.
8. Client hydrates local state from the snapshot.
9. Client builds initial request plans for visible layers and visible view.
10. Client begins data-plane fetches for currently needed tiles/bricks/previews.

### 4.6 State transitions

- `client_roster` gains a new entry.
- Session revision advances.
- No scene or view changes are required unless the engine initializes a blank client view.

### 4.7 Data-plane behavior

- No payload bytes go over the control plane.
- After snapshot hydration, the client independently computes which chunk keys are needed and begins HTTP requests.

### 4.8 Failure cases

- Invalid or missing view token when token-view mode is enabled: reject attach.
- Invalid control token: attach as view-only if policy allows, otherwise reject.
- Capability mismatch (for example, no supported quantitative codec): client may attach but fall back to previews-only or reduced functionality.
- Snapshot too stale due to race with concurrent scene updates: engine may send snapshot then subsequent events immediately; client must apply both in order.

### 4.9 Invariants and tests

- The first authoritative object a client sees must be a full snapshot.
- A client that disconnects and reconnects must be able to recover solely from snapshot + subsequent events.
- Capability negotiation must not alter authoritative scene state.

---

## 5. Sequence 02: Add source and bootstrap first 2D view

### 5.1 Purpose

Register a source, create dataset/layer bindings, detect or build the canonical cache/stream store, and render the first preview/refined 2D view.

### 5.2 Actors

- User
- Client
- Engine
- Builder
- Data Store

### 5.3 Trigger

User invokes one of:
- `scene.add_source`
- `lucida open <path>`
- `viewer.add_image(...)`

### 5.4 Preconditions

- Client has control permission and lease.
- Source path/URI is reachable by the engine.

### 5.5 Ordered flow

1. Client submits `scene.add_source` with source URI and optional initial source metadata hints.
2. Engine validates lease and control permission.
3. Engine registers a new `SourceRecord` with `watch_enabled=true` and status `watching` or `building`.
4. Engine emits `scene.source_upsert`.
5. Engine creates a default `DatasetBinding` pointing at `generation_ref.mode = working`.
6. Engine emits `scene.dataset_upsert`.
7. Engine creates one or more layers associated with the dataset (usually image layer first).
8. Engine emits `scene.layer_upsert` and updates `layer_order` as needed.
9. Engine begins source inspection:
   - detect format
   - infer axis mapping to canonical order
   - infer or record calibration status
   - inspect channel count and metadata
10. Engine emits `source.generation_detected` for the initial working generation.
11. Builder starts canonical cache + stream store generation for `gen_...`.
12. Engine emits `source.generation_started`.
13. Builder creates the coarsest preview / first-usable 2D LOD assets first.
14. Engine emits `source.generation_progress` as assets become available.
15. Client receives layer upserts and source progress events.
16. Client computes needed preview/tile keys for current viewport.
17. Client requests previews/tiles from the data plane.
18. As the first preview arrives, client renders first paint.
19. As quantitative tiles arrive, client replaces preview content with higher-fidelity content for the same generation.
20. Once the required 2D LODs exist for current view, engine emits `source.generation_ready` for the 2D-capable parts of the generation.

### 5.6 State transitions

- Shared scene gains source, dataset binding, and image layer.
- Source status moves through `watching/building`.
- `latest_working_generation_id` / `generation_seq` advance.
- Layer warnings may include uncalibrated or build-incomplete warnings.

### 5.7 Data-plane behavior

- The client first requests `preview2d` assets or coarse 2D tiles.
- The client then requests quantitative `tile2d` payloads for current viewport.
- Requests are keyed by dataset/layer/generation/LOD/index selection/channel block/coords.

### 5.8 Failure cases

- Source unreadable: engine emits `source.generation_failed` and marks the source/layer with a warning.
- Axis mapping ambiguous: engine may accept source as uncalibrated/unknown with warnings.
- Builder crash or disk exhaustion: generation fails; scene remains but layer is not viewable until retry.
- Missing previews but quantitative tiles available: client may render quantitative tiles directly if enough of them arrive.

### 5.9 Invariants and tests

- A layer becomes visible in the scene before all payloads are ready.
- First paint should come from preview/coarse assets, not from waiting for full-res tiles.
- The client must never request or render payloads from a generation that has not been announced in authoritative state.

---

## 6. Sequence 03: Enter 3D mode and lazily build bricks

### 6.1 Purpose

Transition an image layer from 2D use to 3D use by lazily building 3D bricks and rendering orthoslices / MIP / raymarch progressively.

### 6.2 Actors

- User
- Client
- Engine
- Builder
- Data Store

### 6.3 Trigger

User enters 3D mode or issues a 3D-specific command.

### 6.4 Preconditions

- Layer has a valid source/dataset binding.
- Client has an active image layer visible.

### 6.5 Ordered flow

1. Client updates its per-client view state to 3D mode (for example `view.set_rendering_overrides` or mode-specific command).
2. Engine acknowledges and emits `view.updated` with `view_mode=3d`.
3. Client checks whether `brick3d` representation is available for the current generation and layer.
4. If unavailable or incomplete, engine/builder schedules lazy 3D brick build for that layer/generation.
5. Engine emits `source.generation_progress` reflecting brick build progress and MAY mark layer warnings as build-incomplete.
6. Builder creates coarse 3D bricks first.
7. Client requests coarse bricks sufficient for:
   - orthoslices at current camera target
   - MIP/slab for current volume bounds
   - raymarch fallback quality
8. Client renders coarse 3D output as soon as brick coverage is sufficient.
9. Builder continues generating finer bricks and lower-latency brick subsets around the current camera target.
10. Client incrementally refines the view as finer bricks arrive.
11. When enough brick coverage exists, engine clears build-incomplete warnings or emits `source.generation_ready` for the 3D representation.

### 6.6 State transitions

- Per-client view enters 3D mode.
- Source generation build state advances for the 3D representation.
- Layer warnings may temporarily include `generation_build_incomplete`.

### 6.7 Data-plane behavior

- Orthoslices, slab, and raymarch all fetch `brick3d` payloads.
- The client selects bricks based on view frustum, slab extents, and target FPS.
- Missing fine bricks are substituted by coarser bricks from the same generation.

### 6.8 Failure cases

- Brick build fails after 2D is already usable: 2D remains usable; 3D mode shows warning and degrades gracefully.
- Device cannot support needed 3D texture sizes: client chooses smaller brick working sets or lower quality.
- Source anisotropy severe: brick auto-tuner must still produce world-space-ish bricks and not assume cubic voxel spacing.

### 6.9 Invariants and tests

- 3D mode must not require prebuilt bricks at source-open time.
- Orthoslices in 3D must never silently switch back to 2D tiles.
- Coarse-to-fine refinement in 3D must stay within a generation.

---

## 7. Sequence 04: Source update -> new working generation -> trickle-in replacement

### 7.1 Purpose

Handle source file or directory mutations by creating a new working generation and gradually replacing the visible content with assets from the new generation.

### 7.2 Actors

- Watcher
- Engine
- Builder
- Client
- Data Store

### 7.3 Trigger

The watcher observes a source file or directory change.

### 7.4 Preconditions

- Source is registered and watch-enabled.
- Session or layer references the source via `generation_ref.mode = working`.

### 7.5 Ordered flow

1. Watcher receives one or more filesystem events.
2. Engine starts/restarts the stability debounce timer.
3. When no new events arrive for 2 seconds, engine performs the source stability check:
   - single-file source: verify `(mtime,size)` unchanged across two stat samples separated by 200 ms
   - directory source: debounce-only by default
4. If stable, engine allocates a new working generation (`generation_seq + 1`, new `generation_id`).
5. Engine updates source state and emits:
   - `source.generation_detected`
   - `source.generation_started`
6. Builder begins generating canonical cache / stream store artifacts for the new generation.
7. Client receives generation events and updates its resolved generation for any live dataset bindings.
8. Client does **not** mix old and new generation payloads in a single frame.
9. Client begins requesting the coarsest/preview assets for the new generation.
10. Once enough of the new generation is available for current view, client switches to rendering only the new generation and continues refinement.
11. Builder fills in finer assets.
12. Engine emits `source.generation_progress` and eventually `source.generation_ready`.
13. Old non-pinned working generations become GC-eligible under default policy.

### 7.6 State transitions

- `source.latest_working_generation_id` and `generation_seq` advance.
- Any live `DatasetBinding` resolves to the new generation.
- Layers dependent on pinned older base generations may emit dependency mismatch warnings.

### 7.7 Data-plane behavior

- Old-generation requests still in flight are canceled or ignored on arrival.
- New-generation preview/tile/brick requests begin immediately.
- The client must continue to show a coherent view during replacement, using only old or only new generation assets per layer in any given frame.

### 7.8 Failure cases

- Source never stabilizes because another process writes continuously: engine stays in detected/pending state and may surface a “source still changing” warning.
- New generation build fails: client continues rendering the previous generation if it still exists, with warnings.
- A derived layer pinned to an old base generation remains visible but is flagged stale.

### 7.9 Invariants and tests

- Any source change causes a generation bump; Lucida does not attempt partial dirty-region inference in the source watcher path.
- The “latest + one previous for short TTL” GC policy must not delete the still-visible previous generation before the client has switched to the new one.
- A live scene may legitimately become a mix of different generations across different sources; per-layer internal consistency is the requirement.

---

## 8. Sequence 05: 2D navigation (pan, zoom, z/t/channel change)

### 8.1 Purpose

Specify the low-latency navigation loop for 2D viewing, including client prediction, authoritative state reconciliation, request scheduling, and checkpointing.

### 8.2 Actors

- User
- Client
- Engine
- Data Store

### 8.3 Trigger

User performs a 2D navigation or viewing gesture:
- pan
- zoom
- z scroll
- t change
- visible channel change

### 8.4 Preconditions

- Client is attached and has a valid image layer in view.
- The relevant generation and at least coarse 2D assets are available.

### 8.5 Ordered flow: pan/zoom

1. User begins drag or scroll gesture.
2. Client emits `gesture.begin` for the relevant operation.
3. Client predicts local camera/view change immediately.
4. Client issues high-rate view commands or gesture updates (for example `view.pan`, `view.zoom`) with increasing `client_seq`.
5. Engine acknowledges commands and emits `view.updated` authoritative state.
6. Client reconciles any drift between predicted and authoritative values by easing.
7. Client recomputes needed tile sets:
   - current viewport at selected LOD
   - predicted viewport region for motion prefetch
   - refinement LOD if zooming in
8. Client cancels stale requests and issues new tile requests.
9. As tiles arrive, client replaces old visible tiles with higher-priority/new tiles.
10. On gesture end, client emits `gesture.end`.
11. Engine commits a checkpoint at gesture end or after settle debounce.

### 8.6 Ordered flow: z/t/channel change

1. User scrolls or sets a discrete index/channel change.
2. Client predicts the new selection immediately in local view state.
3. Client issues `view.set_indices` or `view.set_channels`.
4. Engine emits authoritative `view.updated`.
5. Client computes needed tile keys for the new `(t, z, channel blocks)` selection.
6. Client cancels stale requests and fetches new tiles.
7. Engine checkpoint policy follows settle/debounce behavior so a long z scrub does not generate one history node per intermediate plane.

### 8.7 State transitions

- Only the requesting client's `client_view` changes.
- No shared scene state changes occur.
- Checkpoints enter history at gesture end/settle points.

### 8.8 Data-plane behavior

- LOD selection is client-driven.
- During zoom-in, client prioritizes current viewport at current LOD, then finer LOD for current viewport.
- During zoom-out, client prioritizes larger-area coarser tiles.
- Channel selection uses channel blocks; the client fetches the minimal set of blocks covering the requested visible channels.

### 8.9 Failure cases

- Delayed acks: client keeps predicted state but must reconcile on ack/event arrival.
- Requested LOD not built yet: client falls back to nearest coarser available LOD from the same generation.
- Missing channel block: client renders partial channel selection if safe, or marks the layer incomplete until block arrival.

### 8.10 Invariants and tests

- Navigation must feel responsive under prediction even with engine latency.
- Undo after a long pan or z scrub must return to the last settled state, not every intermediate state.
- Channel block overfetch must remain invisible to user semantics: UI is still per-channel.

---

## 9. Sequence 06: 3D navigation (orbit/pan/zoom, orthoslices, slab, raymarch)

### 9.1 Purpose

Specify the low-latency 3D interaction loop and brick request scheduling.

### 9.2 Actors

- User
- Client
- Engine
- Data Store

### 9.3 Trigger

User manipulates a 3D view in any supported mode.

### 9.4 Preconditions

- 3D mode is active.
- At least coarse brick coverage exists or is in progress.

### 9.5 Ordered flow

1. User begins 3D navigation gesture.
2. Client predicts local camera transform immediately.
3. Client sends `view.rotate`, `view.pan`, `view.zoom`, or a mode-specific view update command.
4. Engine emits authoritative `view.updated` for the client.
5. Client computes required brick set using:
   - view frustum
   - camera target neighborhood
   - slab thickness or raymarch bounds
   - current LOD selection
6. Client cancels stale brick requests and issues new ones.
7. Client renders coarse/fallback bricks first, then refines as finer bricks arrive.
8. Engine checkpoints on gesture end/settle as in 2D.

### 9.6 Orthoslice-specific details

- Orthoslices use bricks, not 2D tiles.
- Changing the orthoslice position is treated like a view/index update in per-client state.
- Crosshair and slice indicators are updated in client view state only.

### 9.7 Raymarch-specific details

- Client chooses working LOD to hit target FPS.
- Empty-space skipping MAY use occupancy/mask artifacts if available.
- Missing fine bricks are substituted by coarser bricks; client must indicate any degraded detail if necessary.

### 9.8 Failure cases

- Coarse bricks unavailable: client displays loading/incomplete state and waits; it must not sample 2D tiles as a silent fallback.
- Device budget exceeded: client reduces quality, reduces active brick set, or drops LOD.
- Camera moves faster than network/decode: client keeps stable coarse rendering and cancels refinement.

### 9.9 Invariants and tests

- 3D mode must degrade in quality before it degrades in correctness.
- Bricks must be selected based on current representation and not reuse stale 2D chunk assumptions.

---

## 10. Sequence 07: Save target and jump to target

### 10.1 Purpose

Persist and reuse repeatable navigation/analysis locations.

### 10.2 Actors

- User
- Client
- Engine

### 10.3 Trigger

User saves current view as a target, or jumps to an existing target.

### 10.4 Preconditions

- Save target: client has control token and lease.
- Jump to target: any attached client may jump.

### 10.5 Ordered flow: save target

1. User chooses “save target from current view.”
2. Client assembles target proposal from current client view state:
   - active base layer
   - camera/navigation state
   - viewport-derived analysis ROI in world coords
   - per-target defaults for cutout LOD/halo/channels/z-mode
3. Client submits `scene.target_upsert`.
4. Engine validates lease and control permission.
5. Engine assigns or updates `target_id`.
6. Engine emits `scene.target_upsert` with authoritative target object.

### 10.6 Ordered flow: jump to target

1. User selects target.
2. Client submits `view.jump_to_target` with optional per-call overrides.
3. Engine resolves target and applies it only to that client's view state.
4. Engine emits `view.updated` for that client.
5. Client requests tiles/bricks for the new target location and begins rendering.

### 10.7 State transitions

- Save target mutates shared scene state.
- Jump mutates only requester's `client_view`.

### 10.8 Failure cases

- Target deleted concurrently: jump fails with `not_found`.
- Target base layer missing from current scene: engine may reject, or client may map to a substitute only if explicitly allowed in future.

### 10.9 Invariants and tests

- Jumping to target must restore enough navigation state to make a repeated cutout deterministic.
- Saving a target must not implicitly alter the current view.

---

## 11. Sequence 08: Target or current view -> RegionRecipe -> cutout materialization

### 11.1 Purpose

Generate the deterministic description of an ROI and materialize it as a chunked cutout for analysis/prototyping.

### 11.2 Actors

- User or Compute Client
- Client
- Engine
- Data Store

### 11.3 Trigger

User requests a cutout from current view or from a target.

### 11.4 Preconditions

- Base layer is known or derivable.
- Requested generation is resolved.
- Requested representation is known (`tile2d` or `brick3d`).

### 11.5 Ordered flow

1. Client issues `cutout.create` using one of:
   - `source.mode = current_view`
   - `source.mode = target`
   - `source.mode = recipe`
2. Request includes or inherits:
   - base layer override or target default base layer
   - `lod = full | match_view | int`
   - channel policy
   - halo
   - plane/slab/volume mode
3. Engine resolves the request into a concrete RegionRecipe:
   - resolves base layer, dataset, generation
   - resolves requested LOD into integer `lod_resolved`
   - resolves channel blocks from visible/explicit/all policy
   - computes core ROI and halo ROI in world/index/chunk coordinates
   - generates resolved chunk manifest
4. Engine returns RegionRecipe and cutout response with chunk refs/descriptors.
5. Client or Compute Client fetches chunk payloads directly from the data plane.
6. Client or Compute Client exposes them through a chunked array interface.
7. Optional dense adapter is constructed client-side for code that needs dense arrays.

### 11.6 State transitions

- RegionRecipe creation need not mutate shared scene state.
- The engine MAY record a transient recipe registry keyed by `recipe_id` for follow-on publish commands.

### 11.7 Data-plane behavior

- Payload transport default is by external refs, not inline bytes.
- Halo is expressed by default in chunk units at the requested LOD.
- For `lod = match_view`, the recipe captures the effective currently rendered LOD so it remains reproducible.

### 11.8 Failure cases

- Requested generation no longer available: engine returns `generation_not_available`.
- Requested channels exceed layer channel count: validation error.
- Requested LOD not built yet: engine may either reject or resolve to the nearest available lower-fidelity representation if policy allows; if resolved differently than requested, that must be explicit in the recipe.

### 11.9 Invariants and tests

- RegionRecipe must be deterministic for the same target/current view + overrides + generation.
- A saved recipe must preserve the exact chunk manifest and transforms needed for reproduction.
- The recipe must make halo vs core chunk membership explicit.

---

## 12. Sequence 09: Prototype compute -> publish sparse derived layer chunks

### 12.1 Purpose

Take a cutout, run prototype analysis, and publish chunk-aligned output back into Lucida as a sparse derived layer.

### 12.2 Actors

- Compute Client
- Client
- Engine
- Data Store

### 12.3 Trigger

A compute workflow finishes producing chunk-aligned outputs for a cutout.

### 12.4 Preconditions

- Compute workflow has a RegionRecipe or enough information to generate one.
- Output is aligned to the requested representation grid and chunk boundaries.
- Publisher has a control token.

### 12.5 Ordered flow

1. Compute Client runs analysis on the cutout.
2. Output is produced as chunk-aligned data on the same spatial grid/world transform as the base layer.
3. Compute Client decides publish mode:
   - overwrite existing derived layer
   - create new derived layer
4. If creating a new derived layer:
   - client issues `publish.create_layer` (shared scene edit, requires lease)
   - engine emits `scene.layer_upsert`
5. Compute Client writes chunk payloads to staging storage or otherwise obtains external payload refs.
6. Compute Client submits `publish.write_chunks` with:
   - `publish_batch_id`
   - target layer info
   - dependency policy and base generation
   - representation and LOD
   - publish extent (`halo` default, `core` optional)
   - chunk payload refs + stats/checksums
7. Engine validates:
   - control token present
   - payloads match chunk grid and declared shapes
   - dependency references exist
   - overwrite ACL if applicable
8. Engine emits `publish.started`.
9. Engine commits chunks into the sparse derived layer representation.
10. Engine increments layer `write_rev`.
11. Engine emits `publish.completed` and `scene.layer_upsert` if layer metadata changed.
12. Clients with the layer visible request newly available derived chunks and render them.
13. Builder MAY schedule coarser derived LOD generation from the newly published LOD.

### 12.6 State transitions

- For new layer: shared scene gains a new derived layer.
- For any publish: derived layer `write_rev` advances.
- Dependency metadata is recorded on the derived layer.

### 12.7 Data-plane behavior

- Publish payload mode defaults to external refs.
- Derived chunks become available on the data plane once committed.
- Missing derived chunks remain transparent.

### 12.8 Failure cases

- Payload shape mismatch: reject publish.
- Chunk refs unreadable or checksum mismatch: reject batch or mark batch failed.
- Concurrent publish writes to same chunks: later accepted batch wins per chunk; both are audit logged.
- Publisher tries to overwrite a layer without ACL permission: reject.

### 12.9 Invariants and tests

- Derived layer chunks must align exactly with the declared recipe grid.
- Default publish extent must include halo chunks.
- Derived layer visibility must update incrementally as chunks commit; missing regions stay transparent.
- If the derived layer was computed at LOD > 0, clients must surface “computed at LODk” when displayed beyond native detail.

---

## 13. Sequence 10: Metadata sidecar hot reload -> filter recompute -> label visibility update

### 13.1 Purpose

React to metadata sidecar updates by recomputing label filter results and updating label rendering without rebuilding the label raster.

### 13.2 Actors

- Watcher / metadata subsystem
- Engine
- Client

### 13.3 Trigger

The label metadata sidecar changes or is replaced.

### 13.4 Preconditions

- Layer is a labels layer with Lucida-managed metadata sidecar.
- At least one client has an active filter or the layer is otherwise visible.

### 13.5 Ordered flow

1. Metadata subsystem detects a sidecar revision change.
2. Engine validates and loads the new metadata revision.
3. Engine increments `metadata_rev` for the layer.
4. Engine emits `metadata.updated`.
5. For each client with an active filter on the layer, engine re-evaluates the filter DSL AST against the new sidecar revision.
6. Engine resolves the matching dense ID set.
7. Engine generates a visibility bitset (optionally compressed on wire).
8. Engine emits `metadata.filter_result_ready` to relevant clients.
9. Client reconstructs the bitset and uploads/updates the GPU visibility mask.
10. Client re-renders label visibility immediately without re-fetching label raster chunks.

### 13.6 State transitions

- Layer `metadata_rev` advances.
- Per-client filter render state updates implicitly through the new filter result.

### 13.7 Data-plane behavior

- Metadata filter results travel on the control plane (or as control-plane linked payloads), not through the normal tile/brick data plane.
- Label raster data remains unchanged.

### 13.8 Failure cases

- Sidecar unreadable or malformed: emit `metadata.filter_result_failed` and keep last valid filter result or default to show-unknown behavior.
- New metadata enumerates IDs inconsistent with label mapping: layer gets `incomplete_label_index` warning.
- Dense mapping epoch changes: engine emits `labels.mapping_epoch_changed`; clients must refresh GPU lookup resources.

### 13.9 Invariants and tests

- Label filter updates must not require label raster rebuild.
- Unknown metadata policy default is show; hiding unknown must be explicit in filter request/state.
- Metadata hot reload must be visible to all clients with the labels layer active.

---

## 14. Sequence 11: Acquire or steal lease -> shared scene edit -> audit

### 14.1 Purpose

Specify how clients gain shared edit authority and how shared scene edits propagate.

### 14.2 Actors

- Control Client A
- Control Client B
- Engine

### 14.3 Trigger

A control client wants to edit shared scene state.

### 14.4 Preconditions

- Client has a control token.

### 14.5 Ordered flow: request lease (no current holder)

1. Client issues `lease.request`.
2. Engine grants the lease.
3. Engine updates `lease_state`.
4. Engine emits `lease.changed` to all clients.
5. Engine appends audit entry.

### 14.6 Ordered flow: steal lease (current holder exists)

1. Client B issues `lease.steal`.
2. Engine grants B the lease immediately.
3. Engine updates `lease_state`.
4. Engine emits `lease.changed` to all clients.
5. Engine appends audit entry indicating steal event.
6. Former holder A receives passive notification only.

### 14.7 Ordered flow: shared scene edit

1. Lease holder issues a scene command, for example:
   - `scene.layer_add`
   - `scene.layer_remove`
   - `scene.layer_set_defaults`
   - `scene.target_upsert`
2. Engine validates control token and confirms current lease holder.
3. Engine applies the change.
4. Engine increments `scene_rev` and relevant `layer_rev` / object revisions.
5. Engine emits typed scene events.
6. Engine appends audit entry.

### 14.8 State transitions

- Lease holder changes as needed.
- Shared scene state changes only under valid lease.
- Audit log grows.

### 14.9 Failure cases

- Scene edit attempted without lease: reject with `lease_required`.
- Client loses lease between local UI action and command arrival: reject with `lease_required` or `precondition_failed`.
- Two clients race to steal: `session_rev` total order decides the winner.

### 14.10 Invariants and tests

- Only one lease holder may exist at a time.
- Lease changes must be observable to all clients before subsequent scene edits are interpreted.
- Audit entries must preserve enough data to reconstruct who changed what and when.

---

## 15. Sequence 12: Context package capture and reopen

### 15.1 Purpose

Capture a reproducible “what I saw” artifact and reopen it later for frozen or interactive viewing.

### 15.2 Actors

- User
- Client
- Engine
- Data Store

### 15.3 Trigger

User invokes “capture context package” or `lucida snapshot --out ...`.

### 15.4 Preconditions

- Client is attached to a session.
- Current visible state is known and renderable.

### 15.5 Ordered flow: capture

1. Client requests context capture.
2. Engine and/or client freeze the authoritative references needed for capture:
   - session id
   - scene rev
   - client view rev
   - exact generation ids for all referenced datasets/layers
3. Client renders current main view image.
4. Client renders minimap image with viewport overlay.
5. Client records effective LOD by layer and any active warnings.
6. Engine or client gathers:
   - shared scene snapshot
   - client view snapshot
   - generation refs
   - warning taxonomy entries
   - command schema refs / affordances
7. If capture mode is `thick_minimal`, the minimal required chunk manifests/payloads are bundled.
8. Package is assembled and written to output.

### 15.6 Ordered flow: reopen

1. User opens the context package.
2. Reader loads rendered assets and metadata immediately.
3. If referenced datasets/generations are reachable, Lucida may rehydrate into an interactive scene at the same view state.
4. If not reachable, Lucida presents a frozen view with metadata and warnings intact.

### 15.7 State transitions

- Capture does not mutate shared scene state.
- Reopen may create a new session or ephemeral local session state.

### 15.8 Failure cases

- Underlying generation already GC'd and not pinned: frozen mode still works, interactive rehydration fails gracefully.
- Thick-minimal package missing a payload: the package still opens but may show incomplete interactive content.
- A visible derived layer depends on an older base generation: package records the warning and reopen must preserve it.

### 15.9 Invariants and tests

- Context packages must always contain the exact rendered pixels seen at capture time.
- Effective LOD and warning state must be preserved so later sharper rendering does not silently masquerade as the originally seen result.

---

## 16. Sequence 13: Scene file export and reopen

### 16.1 Purpose

Export or reopen a scene configuration separate from a specific captured viewport.

### 16.2 Actors

- User
- Client
- Engine

### 16.3 Trigger

User exports a scene file or opens one.

### 16.4 Preconditions

- For export: session exists.
- For live scene export: implementation should warn that the scene tracks `@working`.

### 16.5 Ordered flow: export

1. Client requests scene export.
2. Engine gathers shared scene state:
   - sources
   - dataset bindings
   - layers and order
   - targets
   - overview policy
   - shared defaults
3. If any dataset binding uses `generation_ref.mode = working`, engine marks scene as live and adds export warning.
4. Engine writes the scene file.

### 16.6 Ordered flow: reopen

1. User opens a scene file.
2. Engine reconstructs sources, dataset bindings, layers, targets, and defaults.
3. If scene is pinned, engine resolves exact generation refs.
4. If scene is live, engine resolves current working generations.
5. Client attaches and receives a snapshot for the newly opened or reconstructed scene.

### 16.7 Failure cases

- Source URI not reachable: scene loads with unresolved source warnings.
- Pinned generation not available: scene opens with missing-data warnings; user may choose alternate bindings later.

### 16.8 Invariants and tests

- Scene files must not require embedding rendered images.
- Scene files must not treat any one client's view as authoritative shared state.

---

## 17. Sequence 14: Label raster generation change

### 17.1 Purpose

Handle a changed labels raster as a new label generation rather than an in-place mutation.

### 17.2 Actors

- Watcher
- Engine
- Builder
- Client

### 17.3 Trigger

The underlying label raster source changes.

### 17.4 Preconditions

- The labels layer is source-backed or otherwise tied to a watched dataset.

### 17.5 Ordered flow

1. Source update path triggers a new generation as in Sequence 04.
2. Builder produces the new label raster generation.
3. If metadata enumerates IDs, the engine computes/updates dense mapping for the new generation.
4. If the mapping epoch changes materially, engine emits `labels.mapping_epoch_changed`.
5. Any active filters are recomputed against the new metadata / mapping.
6. Clients fetch new label raster chunks and new visibility masks as needed.
7. Layer remains conceptually the same layer object if dataset binding is live, but the raster generation has changed.

### 17.6 Failure cases

- New raster contains IDs not present in metadata: surface incomplete index warning.
- Dense remap cannot be built: labels may still render using fallback ID hashing, but metadata filtering becomes degraded.

### 17.7 Invariants and tests

- Lucida must treat changed label raster as a new generation, not silent in-place mutation.
- Dense ID stability should be preserved where original IDs persist.

---

## 18. Sequence 15: “Live view” or observer attach to a session (non-broadcast mode)

### 18.1 Purpose

Allow multiple observers to attach to the same session and watch the shared scene while retaining their own independent per-client view state unless they choose to follow a target or presenter in future extensions.

### 18.2 Actors

- Observer Client
- Engine

### 18.3 Trigger

A second or nth user opens the same session.

### 18.4 Preconditions

- Session is reachable.
- View mode is open or the observer has a valid view token.

### 18.5 Ordered flow

1. Observer attaches using Sequence 01.
2. Engine sends full session snapshot.
3. Observer receives current shared scene state and its own fresh per-client view state.
4. Observer may independently navigate, change per-client rendering overrides, and inspect layers without affecting others.
5. If another client edits shared scene state, observer receives typed events and updates its scene accordingly.

### 18.6 Invariants and tests

- Multiple clients must be able to inspect the same scene without competing for camera control by default.
- Read-only observers must still be able to manipulate their own view state.

---

## 19. Cross-sequence failure taxonomy

The following failures recur across sequences and should be represented consistently in engine errors, warnings, and UI states.

### 19.1 Permission / lease failures

- `permission_denied`
- `view_token_required`
- `invalid_control_token`
- `lease_required`
- `lease_lost`

### 19.2 Revision / ordering failures

- `stale_revision`
- `precondition_failed`
- `out_of_order_client_seq`

### 19.3 Data / source failures

- `source_unavailable`
- `source_unstable`
- `generation_not_available`
- `generation_build_failed`
- `payload_not_found`
- `checksum_mismatch`

### 19.4 Metadata / labels failures

- `metadata_load_failed`
- `filter_evaluation_failed`
- `incomplete_label_index`
- `mapping_epoch_changed`

### 19.5 Publish / derived layer failures

- `publish_shape_mismatch`
- `publish_payload_unreadable`
- `publish_acl_denied`
- `dependency_generation_missing`

---

## 20. Minimum acceptance scenarios

The following scenario set should be used as the first workflow-level test suite.

1. Attach a view-only client to an open-view LAN session and render an existing 2D layer.
2. Add a TIFF source, receive preview first paint, then quantitative 2D refinement.
3. Enter 3D mode and obtain usable coarse orthoslices before fine bricks are ready.
4. Modify a watched source, observe a new generation, and confirm that no frame mixes old/new generation payloads.
5. Save a target, jump away, jump back, and verify the same RegionRecipe is regenerated.
6. Request a full-res cutout with halo, run external compute, publish a new sparse derived layer, and confirm missing chunks are transparent.
7. Change label metadata sidecar, recompute filter, and update label visibility without rebuilding label raster.
8. Steal lease from another control client, perform a shared scene edit, and verify audit log contents.
9. Capture a Context Package and reopen it without source access; verify frozen main view + minimap + warnings are preserved.
10. Export a live Scene file, reopen it, and verify that it resolves current working generations while preserving shared scene structure.

---

## 21. Open implementation notes (non-blocking)

These do not block the workflow spec but will matter during implementation planning.

1. Whether control-plane transport is WebSocket or WebTransport does not change sequence semantics, but affects framing and retry behavior.
2. Some large filter bitsets may eventually be better delivered as side-band control-plane linked payloads rather than inline JSON fields.
3. Context Package capture may be implemented client-side, engine-side, or hybrid, provided the output semantics match this spec.
4. Builder progress granularity is intentionally unspecified; only event ordering and meaning matter here.

