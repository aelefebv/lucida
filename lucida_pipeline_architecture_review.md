# Lucida Pipeline Rewrite: Architectural Review and Recommendation

## Status

The recommendation is to proceed with the rewrite, but to finalize it as a **two-physical-cache, two-representation, three-scheduling-lane** system rather than a single uniform chunk pipeline.

The core conclusion is:

- The **physical cache tiers** should remain:
  - **Network / server**
  - **CPU cache on the main thread**
  - **GPU cache in a worker**
- The **logical data representations** should be split into:
  - **Overview** representations for navigation and semantic fallback
  - **Detail** representations for exact chunked rendering
- The **scheduler** should operate in three lanes:
  - **Overview lane**
  - **Exact current detail lane**
  - **Temporal runway lane** for smooth scrubbing

This is the architecture most consistent with the product constraints:

- large OME-Zarr datasets
- HCS plates
- large single-dataset 3D volumes
- multiplex images/slides
- continuous camera motion
- continuous time scrubbing
- multi-channel viewing
- browser execution with WebGPU
- data streamed through a server proxy, potentially backed by GCS

---

## 1. Problem Statement

Lucida is a collaborative viewer for high-dimensional microscopy data. The current pipeline does not scale well when:

- datasets are large
- data is plate-based
- many fields of view are visible or potentially visible
- users scrub time continuously
- users combine multiple channels
- data arrives progressively over the network
- rendering must remain interactive while loading continues

The rewrite is intended to replace everything between scene/camera state and final pixels:

- chunk planning
- network fetch orchestration
- CPU-side decompressed caching
- main-thread ↔ worker protocol
- GPU residency management
- atlas or cache texture management
- page table management
- slice and volume rendering orchestration

The React UI, WASM scene brain, and server-side collaboration model can remain.

---

## 2. What Must Be True After the Rewrite

The system should satisfy the following invariants.

### 2.1 Interaction invariants

1. Camera movement must remain responsive.
2. The renderer must never stall waiting for data.
3. A coarse but spatially correct overview should appear quickly.
4. Images should refine progressively as more data arrives.
5. Time scrubbing should feel continuous.
6. Multi-channel viewing must be supported as a first-class case.
7. Plate navigation and single-dataset navigation must both work well.
8. Minimap/overview navigation must be supported.

### 2.2 Semantic invariants

1. Falling back to **coarser spatial LOD** is acceptable.
2. Falling back to the **wrong timepoint** is not acceptable in the main view.
3. Falling back to the **wrong channel state** is not acceptable in the main view.
4. Missing fine detail should reveal a **current-T/current-channel overview**, not stale T/C data.

### 2.3 Ownership invariants

1. The main thread owns CPU residency.
2. The worker owns GPU residency.
3. The server owns storage layout and transport grouping.
4. Layout/presentation should not affect canonical data identity.

---

## 3. Key Input Constraints

The architecture below is based on the following operating assumptions.

### 3.1 Dataset scales of interest

Representative HCS target:

- up to **384 wells**
- up to **~20 fields per well**
- up to **4 channels** routinely, more in some cases
- up to **120 timepoints**
- around **10 Z slices**
- chunks around **256 × 256 × 10** voxels
- **16-bit** data

Representative multiplex / slide-like target:

- one very large image or shallow volume
- around **12 channels**
- a few Z planes

### 3.2 Usage patterns

Both are common:

- zoomed-out plate browsing
- focused work on individual fields / wells / datasets

Additional assumptions:

- camera changes happen much more often than content membership changes
- time scrubbing should feel close to continuous
- users may view one or several channels simultaneously
- chunk delivery can remain client-local and opportunistic
- overview-first/progressive loading is acceptable
- minimap/overview is important

---

## 4. Why a Single Uniform Chunk Strategy Is Not Enough

A critical design mistake would be to treat every visible object at every zoom level as just another set of ordinary detail chunks.

Consider one 256 × 256 × 10 chunk of `u16` voxels:

- 256 × 256 × 10 × 2 bytes ≈ **1.25 MiB per channel**
- with 4 channels, one spatial chunk location is ≈ **5 MiB**

A zoomed-out plate view with thousands of fields cannot use “one ordinary seed chunk per visible field per channel” as its universal fallback. That would exceed both CPU and GPU budgets immediately.

Therefore, the system must distinguish between:

- **overview representations**, which are cheap and global
- **detail representations**, which are exact and bounded to an active subset

This is the central architectural decision.

---

## 5. Recommended High-Level Architecture

### 5.1 Physical cache tiers

Use the proposed two-tier cache model:

```text
Network / Server -> CPU Cache (main thread) -> GPU Cache (worker) -> Renderer
```

This is correct.

### 5.2 Logical representation split

Introduce two distinct data representation families.

#### Overview representations

Used for:

- initial display
- plate/well/slide navigation
- minimap
- semantic fallback when exact fine detail is missing

Properties:

- cheap to load
- spatially correct
- current-T/current-channel correct in the main view
- can be 2D or 3D depending on dataset and mode

#### Detail representations

Used for:

- exact rendering of active fields / volumes
- full chunked refinement
- slice and volume rendering at interactive scales

Properties:

- native chunked multiscale data
- page-table-backed GPU residency
- bounded to a selected or promoted active set

### 5.3 Scheduling lanes

Do not use a single flat global queue for every kind of data. Instead, schedule three lanes.

#### Lane 1: Overview

Highest obligation for semantic continuity.

Responsibilities:

- current-T/current-channel coarse visibility
- minimap support
- zoomed-out plate/well/slide navigation
- fallback under missing detail

#### Lane 2: Exact current detail

Highest-value refinement work.

Responsibilities:

- exact current T
- exact current visible channels
- promoted active fields/volumes
- seed-first then refine-to-target-LOD

#### Lane 3: Temporal runway

Used only to make scrubbing feel continuous.

Responsibilities:

- exact adjacent T values
- coarse readiness for likely next timepoints
- only for currently active members
- not used as semantic fallback until selected T changes

This is fundamentally safer than stale-T fallback.

---

## 6. Dataset Topology Model

Use stable OME-Zarr topologies as the outer taxonomy and a Lucida abstraction underneath.

### 6.1 Stable topologies to support now

#### Image topology

Use this for:

- single datasets
- large 3D volumes
- multiplex datasets that are one image / one volume
- large slides when represented as one multiscale image

Overview source:

- native multiscale image levels

Detail source:

- same image at finer levels

#### Plate topology

Use this for:

- HCS plates

Overview source:

- Lucida-defined plate/well/field overview products

Detail source:

- native field images under each well

### 6.2 Future topology

A future Lucida `scene` topology can represent arbitrary aligned multi-image scenes. This can later converge with richer OME-NGFF scene/coordinate-system work if desired, but it is not needed to define the current rewrite.

---

## 7. Coordinate System and Layout Model

### 7.1 Canonical geometry vs presentation layout

These must be separated.

#### Canonical geometry

Answers:

- where does a field live inside a well?
- what are a field’s real bounds?
- what transform places voxels into field-local space?

#### Presentation layout

Answers:

- where do I want this well shown right now?
- am I looking at source plate layout or a synthetic comparison grid?

This separation enables:

- canonical source plate layout
- filtered condition layouts
- custom 2×3 grids of selected wells
- future ranked or clustered views

without changing the underlying data identities.

### 7.2 Recommended transform stack

For HCS:

```text
voxel -> imageIntrinsic -> fieldLocal -> wellLocal -> layoutLocal -> world
```

Where:

- `imageIntrinsic` comes from image metadata and multiscale transforms
- `fieldLocal -> wellLocal` comes from Lucida ingest / manifest / trusted source metadata, falls back to a square grid default
- `wellLocal -> layoutLocal` comes from the active layout view
- `layoutLocal -> world` comes from the camera/view scene

### 7.3 Why this matters

This model makes the following possible without duplicating data:

- source plate view
- condition-based rearrangement of wells
- custom side-by-side comparison views
- minimap based on the same canonical well/field content

The same well proxy can be reused in any layout because it lives in **well-local coordinates**, not plate-global coordinates.

---

## 8. Overview Products

Overview should be a first-class concept. It is not always the same as “coarsest ordinary LOD”.

### 8.1 For single images / volumes / multiplex datasets

Use the native image multiscale pyramid directly as the overview family.

This applies to:

- single 3D datasets
- multiplex images that are one multiscale image
- large slides represented as one multiscale image

### 8.2 For plates

Use derived overview products.

Recommended hierarchy:

- **plate overview**: a set of well instances placed in the active layout
- **well overview**: a set of field proxies placed in well-local space
- **field detail**: native chunked field data

### 8.3 3D plate/well support

Since wells and plates should be viewable in 3D, the overview layer must be volumetric.

Recommended hierarchy for 3D:

- **wellProxy3D**: a coarse volume representing a well in well-local space
- **fieldProxy3D**: a coarse volume representing one field in field-local space
- **native field detail**: true chunked field data

Do **not** create one monolithic “plate volume”.

The plate should instead be rendered as a 3D scene of instanced proxy volumes:

- well proxies at plate-scale
- field proxies at well-scale
- native field detail at field-scale

This is much more scalable and preserves the layout/presentation separation.

### 8.4 Semantic requirement for overviews

Main-view overviews must be:

- exact for the selected T
- exact for the visible channels
- spatially lower fidelity only

Overview may be blurrier. It should not silently represent stale timepoints or stale channels in the main view.

---

## 9. Promotion and Demotion Rules

Rendering all visible members as detail is not scalable. The planner should promote only a bounded active subset.

Promotion should be based on **view intent**, not visibility alone.

Recommended factors:

- selectedness
- projected screen size
- centroid distance
- render mode (slice vs volume)
- current interaction mode (steady vs scrubbing)

### 9.1 Suggested initial thresholds

These are engineering starting points, not permanent truths.

#### Well promotion

Promote a well from plate overview to well overview when:

- projected well diagonal >= 96 px, or
- the well is selected

Demote when:

- projected well diagonal < 72 px

Bound the promoted set:

- at most 9 promoted wells initially

Selection order:

1. selected wells
2. largest projected area
3. nearest to focus

#### Field promotion in slice mode

Promote a field from well overview to field detail when:

- projected field diagonal >= 192 px, or
- the field is selected

Demote when:

- projected field diagonal < 160 px

Bound the promoted set:

- at most 8 active detail fields initially

#### Field promotion in volume mode

Promote a field from well overview to field detail when:

- projected field diagonal >= 256 px, or
- the field is selected

Demote when:

- projected field diagonal < 224 px

Bound the promoted set:

- at most 4 active detail fields initially

### 9.2 Scrubbing behavior

During active T scrubbing:

- freeze the promoted set of wells and fields
- do not churn membership while the user is dragging rapidly
- prioritize exact current-T overview first
- then exact current-T seed detail
- then exact current-T refinement
- then runway seeds for likely next T values

This reduces scheduler noise and keeps the system focused on the current user action.

---

## 10. Semantic Fallback Policy

This should be locked as a non-negotiable rule.

### Allowed fallback

- current T / current visible channels / coarser spatial LOD
- current T / current visible channels / overview proxy

### Disallowed fallback in the main view

- stale T
- stale channel
- stale channel composites treated as if they were current

### Practical effect

When detail for the current view is missing:

- reveal current overview
- do not keep old T mapped as if it were valid current data
- do not keep old channels mapped as if they were valid current data

Old T and channel data may remain cached physically, but not semantically mapped for the current frame.

---

## 11. Main Thread Responsibilities

The main thread should own:

- scene queries from WASM
- dataset topology and active layout selection
- promotion/demotion decisions
- CPU caching and decompression
- network request scheduling
- epoch management
- hot render-frame packaging for the worker

The main thread should **not** own:

- GPU residency
- page table contents
- slot allocation
- atlas eviction within GPU memory

### 11.1 Planner responsibilities

The planner decides:

- current active layout
- visible wells / fields / images
- which entities stay in overview mode
- which wells are promoted to well overview
- which fields are promoted to detail
- current-T/current-channel exactness requirements
- scrub/runway mode

### 11.2 Epoch model

Use explicit epochs so the system replans only when something meaningful changes.

Recommended epoch categories:

- `layoutEpoch`: well arrangement or scene membership changed
- `viewEpoch`: camera movement caused a new admission result or shell boundary crossing
- `selectionEpoch`: current T/C/render mode changed
- `assetEpoch`: overview/detail metadata changed or new products became available

The planner should avoid rebuilding full request sets on every animation frame unless one of these epochs changes materially.

---

## 12. CPU Cache Architecture

### 12.1 Role

The CPU cache is the RAM-side staging layer between network/server fetches and worker GPU requests.

It should:

- hold decompressed detail chunks for active demand
- hold overview assets or overview tiles/blocks
- schedule fetches by lane and priority
- serve worker requests quickly when data is ready

### 12.2 Logical subdivisions

The CPU layer should be one implementation but two logical stores:

- **overview cache**
- **detail cache**

Because overview and detail have different residency behavior, lifetimes, and usefulness.

### 12.3 Priority lanes

The CPU fetch scheduler should understand at least these lanes:

1. overview
2. exact current detail
3. temporal runway
4. speculative prefetch

The scheduler should budget by:

- bytes in flight
- decode CPU budget
- request concurrency
- lane priority

rather than by a single flat fetch count.

### 12.4 What the CPU cache keys should represent

Keep render identity, cache identity, and transport identity separate.

#### Logical content identity

For detail:

```ts
type DetailContentKey = {
  sourceId: number;
  fieldId: number;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
};
```

For overview:

```ts
type ProxyKey = {
  scope: "image" | "well" | "field";
  entityId: number;
  t: number;
  c: number;
  proxyLod: number;
};
```

These should be canonical and layout-independent.

#### Transport identity

A single server response may correspond to:

- one OME-Zarr chunk
- a byte-range inside a shard
- several coalesced logical chunks
- an overview asset block

The browser caches should not care how the server grouped the bytes.

### 12.5 Memory contract with the worker

The CPU cache should expose an abstraction, not a hard implementation commitment.

Two viable implementations:

#### Option A: standard transferred buffers

- simplest to deploy
- no cross-origin isolation requirement
- transferred `ArrayBuffer`s detach on send
- CPU cache either copies or treats decompressed buffers as one-shot

#### Option B: shared memory

- more efficient
- requires cross-origin isolation and `SharedArrayBuffer`
- cleaner zero-copy sharing between main thread and worker

This should remain an implementation detail behind a `ChunkBufferHandle` abstraction.

---

## 13. Worker / GPU Responsibilities

The worker should own:

- GPU device and resource lifetime
- proxy atlas residency
- detail atlas residency
- page table updates
- slot allocation and eviction
- descriptor buffers
- render submission

The worker should not decide:

- global dataset layout
- which wells belong in a custom comparison grid
- which fields are semantically active for current view intent

Those are planner decisions.

### 13.1 Worker input model

The worker should receive:

- hot per-frame state every frame
- cold layout state only when epochs change
- batched asset deliveries as they become ready

#### Hot state

- camera matrices
- viewport size
- current T
- visible channel mask / channel settings
- render mode
- interaction state (steady, scrubbing)
- active layout ID

#### Cold state

- well list
- field list
- transforms
- volume metadata
- proxy descriptors
- layout placements
- channel metadata if mostly static

This preserves the conceptual simplicity of “fresh frame state” without paying a serialization tax on every frame.

---

## 14. GPU Atlas Strategy

The current atlas concept remains correct, but it should be split by representation family.

### 14.1 Atlas family 1: detail chunk atlas

This is the existing page-table-backed virtual texturing concept.

Purpose:

- exact chunked detail for promoted active fields/volumes

Unit of residency:

- one native chunk page

Suggested key:

```ts
type DetailPageKey = {
  fieldId: number;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
};
```

Properties:

- grouped by chunk dimensions and format
- page-table indirection
- slot allocation/free list
- dedup map
- eviction by lane-aware priority

### 14.2 Atlas family 2: proxy volume atlas

This is a simpler atlas for overview representations.

Purpose:

- well proxies
- field proxies
- native image overview volumes

Unit of residency:

- one overview asset slot

Suggested key:

```ts
type ProxyKey = {
  scope: "image" | "well" | "field";
  entityId: number;
  t: number;
  c: number;
  proxyLod: number;
};
```

Properties:

- no per-proxy page table in v1
- one slot per proxy volume or proxy tile block
- simpler allocation and eviction than detail atlas
- channel-scalar data, not precolored composites

### 14.3 Optional atlas family 3: nav atlas

A future optional `navAtlas2D` can support:

- minimap
- ultra-cheap far-zoom navigation layers
- large slide overviews

This should be a later optimization, not a prerequisite.

### 14.4 Canonical identity rule

Atlas entries should be keyed by canonical asset identity, **not by layout**.

This is essential.

If well `A1` appears:

- in the source plate grid
- in a custom 2×3 condition view
- in a side-by-side comparison layout

then the atlas entry for `A1` stays the same. Only its instance transform changes.

---

## 15. Page Table Model

The page table should exist only for **detail** pages.

It should not be stretched to cover all overview use cases if that makes those use cases unnatural.

### 15.1 Why the page table still matters

For active fields and volumes, the page table remains the right abstraction because:

- datasets are larger than VRAM
- chunks are the native storage unit
- exact rendering requires arbitrary sparse residency
- LOD refinement should be page-granular

### 15.2 Addressing model

Keep content identity separate from page address identity.

#### Content identity

Represents what bytes are actually in a slot.

#### Page address identity

Represents what the shader is asking for at a spatial location.

Suggested split:

```ts
type ChunkContentKey = {
  sourceId: number;
  fieldId: number;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
};

type PageAddress = {
  volumeHandle: number;
  level: number;
  c: number;
  z: number;
  y: number;
  x: number;
};
```

This matters because it prevents accidental semantic confusion and gives a cleaner model for replacing old pages with new exact current pages.

### 15.3 Current-T/current-C requirement

The page table should only map currently valid pages for the current render selection.

Do not keep old T or old channel pages mapped as if they were valid fallback. Use overview proxies for semantic fallback instead.

---

## 16. Descriptor Model Seen by the Shader

The shader should be able to see both overview and detail handles.

A conceptual descriptor for a promoted field or volume should look like:

```ts
type RenderableDescriptor = {
  modelMatrix: Float32Array;
  inverseModelMatrix: Float32Array;

  proxyHandle: number | null;     // overview slot
  pageTableBase: number | null;   // detail pages if promoted

  currentT: number;
  channelMask: number;
  renderMode: number;
};
```

Sampling behavior:

1. If exact detail is present for current T/current channel/current position, use it.
2. Otherwise use the current overview proxy for the same T/channel.
3. Otherwise render nothing for that entity.

That preserves the semantic fallback rule without requiring stale page mappings.

---

## 17. Rendering Model

### 17.1 Main view

The main view should be compositional.

Conceptually:

1. draw overview representation in correct world space
2. overlay exact detail wherever resident
3. missing detail reveals overview underneath

This can be implemented in one pass or a small number of passes depending on engineering convenience, but the semantic model should remain the same.

### 17.2 Slice mode

In slice mode:

- overview must be slice-safe if used as fallback beneath the slice renderer
- for 3D datasets, native low-resolution volume overview works well
- for plates/wells, proxy volumes must support slice-consistent access if they are used beneath the slice view

### 17.3 Volume mode

In volume mode:

- overview may be coarser but should still be volumetric
- well and field proxy volumes are appropriate
- MIP-only proxies can be reserved for minimap or ultra-far zoom, not semantic fallback under the main slice renderer

### 17.4 Minimap

Minimap should become a first-class consumer of the overview lane.

It should not require a completely separate data model.

The minimap can:

- reuse well proxies / image overviews
- use a simpler renderer than the main detail pass
- share transforms and active layout

---

## 18. Server Responsibilities

Because data will likely be proxied, the server should do more than blindly relay bytes.

Recommended server responsibilities:

1. storage-layout translation
2. logical-to-physical request mapping
3. fetch coalescing
4. optional shard/range management
5. overview asset generation or serving
6. session-consistent object/version selection

### 18.1 Why this matters

The browser should ask for logical assets:

- detail chunk pages
- overview assets
- field proxy data
- well proxy data

It should **not** need to know whether the bytes came from:

- individual OME-Zarr chunks
- a shard
- a larger batched object
- a cached overview product

This preserves flexibility as the storage format evolves.

---

## 19. Messaging Model

The three-message model can remain, but with clarified semantics.

### 19.1 Main -> Worker: `renderFrame`

Should carry:

- hot render state every frame
- references to cached layout epochs/descriptors
- not the full cold object graph every frame

### 19.2 Worker -> Main: `chunkRequest`

Should behave like a batched subscription for the current epochs, not a naive per-frame poll.

The worker expresses interest in:

- overview assets
- detail pages
- specific T/C combinations
- specific active fields

The main thread keeps serving those requests as data becomes ready.

### 19.3 Main -> Worker: `chunkDelivery`

Should batch many deliveries and tag them with enough metadata to validate:

- asset kind
- entity identity
- T/C state
- page identity or proxy identity
- epoch / selection compatibility

### 19.4 Serialization guidance

Prefer:

- numeric handles
- flat typed arrays
- compact enums

Avoid:

- repeated deep object trees
- string IDs inside per-frame messages

---

## 20. Layout Views and Custom Well Rearrangement

This architecture should explicitly support synthetic well layouts.

Example requirement:

- show only the six wells with condition X
- arrange them as a 2×3 grid
- keep fields correctly positioned inside each well

This should not require copying or repacking image data.

### 20.1 Canonical entities

```ts
type WellCanonical = {
  wellId: string;
  sourcePlateRow?: number;
  sourcePlateCol?: number;
  fieldIds: string[];
  fieldToWell: Float32Array[];
  annotations: Record<string, unknown>;
};
```

### 20.2 View layout

```ts
type LayoutView = {
  layoutId: string;
  kind: "sourcePlate" | "conditionGrid" | "custom";
  wells: string[];
  wellToLayout: Float32Array[];
};
```

The same canonical wells and field proxies can be instanced in any layout. This is one of the strongest reasons to keep proxies in **well-local** coordinates.

---

## 21. Interaction Between Atlases and Layout Views

This is the direct answer to “how should the atlases exist / be populated under the new model?”

### 21.1 What changes compared with the original idea

The original idea assumed a single chunk/page system was the universal answer.

Under the revised architecture:

- the **detail atlas** still works almost exactly as originally conceived
- the **overview/proxy atlas** is added as a second residency family
- layout changes do **not** repopulate or move atlas data
- layout changes only update instance transforms

### 21.2 Population order

For each planning epoch, populate in this order:

1. visible current-T/current-channel overview assets
2. promoted wells’ field proxy assets
3. promoted fields’ exact detail seeds
4. promoted fields’ target-LOD detail refinement
5. temporal runway seeds for likely next T values

### 21.3 What never changes

- canonical well IDs do not change
- canonical field IDs do not change
- field-to-well transforms do not change because of presentation layout
- atlas keys do not depend on layout

Only the current `LayoutView` changes.

---

## 22. Cross-Origin Isolation and Shared Memory

This is not a blocker for the architecture, but it affects implementation efficiency.

### 22.1 What it is

Browsers only allow `SharedArrayBuffer` between page and worker when the page is **cross-origin isolated**. In practice that means serving the app with appropriate COOP/COEP headers and ensuring embedded resources are compatible with that isolation model. Without that setup, `SharedArrayBuffer` sharing is not available, and transferred `ArrayBuffer`s detach on transfer. [MDN SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) [MDN COEP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy) [MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)

### 22.2 Architectural guidance

Do not make this a prerequisite for v1.

Instead:

- define a `ChunkBufferHandle` abstraction
- support ordinary transfer/copy first
- optionally upgrade to shared-memory delivery later

This keeps the architecture stable even if deployment constraints delay cross-origin isolation.

---

## 23. WebGPU Constraints That Matter Architecturally

WebGPU exposes adapter limits through `GPUAdapter.limits`, and GPU resource allocation must remain within those limits. Texture creation is validated against limits including 3D texture size. [MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits) [MDN createTexture](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createTexture)

Practical implications:

- keep texture classes bounded
- group pages by compatible chunk dimensions and format
- expect a finite number of detail atlas classes
- size proxy volumes so they fit comfortably inside browser/GPU constraints
- isolate atlas allocation failures from the rest of the system

The page table is usually not the first scaling bottleneck. Planning cost, atlas class explosion, upload bandwidth, and message churn will usually matter sooner.

---

## 24. OME-Zarr Assumptions to Preserve

The rewrite should normalize metadata correctly rather than hardcoding assumptions into the planner.

Important rules:

- use image axes metadata as the source of truth for dimension order
- use multiscale metadata and coordinate transformations for level geometry
- treat HCS plate hierarchy separately from image multiscales

For Lucida’s architecture:

- `image` topology can use native multiscale overviews directly
- `plate` topology requires Lucida-defined field placement and overview products layered on top of standard HCS metadata

References: [OME-Zarr 0.5](https://ngff.openmicroscopy.org/0.5/) and [RFC-5](https://ngff.openmicroscopy.org/rfc/5/).

---

## 25. Recommended Module Breakdown

The original proposed module list is close, but should be extended to reflect the overview/detail split and the layout model.

### 25.1 Core planning and data model

- `datasetTopology.ts`
  - normalize `image` vs `plate`
  - expose canonical entities
- `layoutView.ts`
  - source plate layout
  - condition/custom layouts
- `promotionPlanner.ts`
  - overview/promotion decisions
  - screen-space thresholds
  - active set computation
- `requestScheduler.ts`
  - lane-aware fetch ordering
- `chunkIds.ts`
  - dense numeric handles
  - packed logical keys
- `chunkSource.ts`
  - server transport abstraction

### 25.2 CPU side

- `cpuDetailCache.ts`
- `cpuOverviewCache.ts`
- `decodePipeline.ts`
- `pipelineOrchestrator.ts`
- `workerProtocol.ts`

### 25.3 Worker / GPU side

- `detailAtlas.ts`
- `proxyAtlas.ts`
- `pageTable.ts`
- `descriptorBuffers.ts`
- `renderWorker.ts`
- `renderPipeline.ts`
- `volumeShader.wgsl`
- `sliceShader.wgsl`
- `overviewShader.wgsl` if overview rendering is easier to isolate initially

### 25.4 Optional later modules

- `navAtlas2D.ts`
- `overviewAssetBuilder.ts` on the server side
- `scrubPredictor.ts`

---

## 26. Suggested Implementation Order

The order matters.

### Phase 1: Normalize the data model

Implement:

- topology normalization (`image`, `plate`)
- canonical IDs for wells/fields/images
- layout views
- field-to-well transforms
- source plate layout
- condition/custom layout support

Goal:

- prove that layout is independent of residency

### Phase 2: Overview-first rendering

Implement:

- proxy atlas or native overview path
- minimap using overview products
- plate/well/image overview rendering
- layout transitions

Goal:

- prove fast, semantically correct navigation

### Phase 3: Detail cache and page table

Implement:

- detail chunk atlas
- page table
- promoted active fields
- detail-over-overview compositing

Goal:

- prove exact chunked refinement works without breaking overview

### Phase 4: Time scrubbing runway

Implement:

- scrub mode
- lane-aware scheduler
- coarse adjacent-T runway
- exact current-T semantics

Goal:

- prove smooth scrubbing without stale fallback

### Phase 5: Full 3D plate/well proxies

Implement:

- wellProxy3D
- fieldProxy3D
- volumetric overview under the main 3D renderer

Goal:

- unify plate-scale 3D navigation with field detail

### Phase 6: Optional shared memory and transport optimization

Implement later if needed:

- shared-memory handoff
- shard-aware server fetching
- request coalescing improvements
- adaptive atlas rebudgeting

---

## 27. Risks and Mitigations

### Risk 1: Full-scene planning becomes the new bottleneck

Mitigation:

- epoch-based replanning
- bounded promoted sets
- screen-space admission
- lane-aware scheduling

### Risk 2: Overview products drift semantically from detail

Mitigation:

- current-T/current-channel requirement
- slice-safe proxy volumes for main-view fallback
- clear separation between navigation-only MIPs and semantic overview assets

### Risk 3: Layout-specific data duplication

Mitigation:

- canonical asset IDs
- well-local proxies
- layout-only transform changes

### Risk 4: Worker message volume becomes too high

Mitigation:

- hot vs cold state split
- typed-array payloads
- batched deliveries
- request subscriptions rather than per-frame polling

### Risk 5: Too many atlas classes

Mitigation:

- normalize proxy volume shapes where practical
- explicitly limit texture classes
- make atlas class growth visible via counters

### Risk 6: Shared-memory assumptions leak into architecture

Mitigation:

- treat buffer ownership as an abstraction
- keep transport independent from planner/caches

---

## 28. Instrumentation Requirements

Build observability from the start.

Required counters and traces:

- overview cache bytes / hit rate
- detail cache bytes / hit rate
- bytes in flight by lane
- decode time by asset type
- upload time by atlas type
- promoted wells / promoted fields count
- current overview residency ratio
- current exact detail residency ratio
- scrub runway readiness ratio
- message bytes per second
- worker frame time
- shader pass time if measurable
- atlas evictions by reason and lane

Without these, the rewrite will be difficult to tune.

---

## 29. Remaining Design Decisions

There are still a few items worth explicit review, but they are not blockers to architecture approval.

### 29.1 Exact overview asset shape

To finalize:

- dimensions and format of `wellProxy3D`
- dimensions and format of `fieldProxy3D`
- whether proxies are stored densely or in blocked form
- whether native image overview should reuse the proxy atlas path or a dedicated fast path

### 29.2 Proxy generation strategy

To finalize:

- precompute at ingest
- generate lazily on the server
- hybrid strategy with caching

### 29.3 Slice semantics for plate overviews

To finalize:

- whether every plate/well overview used in the main view must be slice-safe
- when MIP-style nav-only assets are acceptable

### 29.4 Scrub prediction policy

To finalize:

- next-T only
- next two T values in current direction
- velocity-aware prediction

### 29.5 Initial budgets

To finalize empirically:

- promoted well count
- promoted field count
- per-lane request concurrency
- CPU budget split between overview and detail
- GPU budget split between proxy and detail atlases

---

## 30. Final Recommendation

Proceed with the rewrite.

But formalize it as the following system:

### Architecture summary

- **One canonical spatial model** for images, wells, fields, and layouts
- **Two stable topologies now**: `image` and `plate`
- **Two logical representation families**:
  - overview
  - detail
- **Three scheduler lanes**:
  - overview
  - exact current detail
  - temporal runway
- **Two GPU atlas families**:
  - proxy atlas for overview assets
  - detail chunk atlas with page table
- **Strict semantic fallback rule**:
  - spatial LOD fallback allowed
  - stale T/C fallback disallowed in main view
- **Layout-independent residency**:
  - well and field proxies live in local coordinates
  - layouts only move instances
- **Server owns storage translation and overview serving**
- **Main thread owns planning and CPU residency**
- **Worker owns GPU residency and rendering**

### Why this is the right shape

It preserves what was correct in the original rewrite proposal:

- pull-based caches
- single ownership per tier
- progressive rendering
- worker-owned GPU state
- page-table detail virtualization

while correcting what would otherwise fail at scale:

- assuming one chunk system can serve all zoom levels equally well
- assuming coarsest ordinary chunk is always an adequate fallback
- assuming visibility alone is sufficient for detail admission
- assuming stale T/C fallback is acceptable
- assuming layout and data identity are the same problem

This version is the smallest architecture that handles:

- large single volumes
- multiplex images/slides
- HCS plates
- 2D and 3D overview
- minimap
- continuous scrubbing
- custom well layouts

without requiring a second system later.

---

## 31. Glossary

### Canonical geometry
The stable transform hierarchy that defines where images/fields/wells actually live relative to one another.

### Presentation layout
A chosen arrangement of canonical entities for viewing, such as source plate layout or a custom condition grid.

### Overview
A coarse but semantically correct representation used for navigation and fallback.

### Detail
Native chunked multiscale data used for exact rendering.

### Proxy
A Lucida-defined overview asset for a well, field, or image.

### Promoted field / promoted well
An entity currently admitted into a more detailed representation because of user view intent.

### Temporal runway
A small amount of exact adjacent-T preparation used to keep scrubbing responsive.

---

## 32. References

- OME-Zarr / NGFF 0.5 specification: <https://ngff.openmicroscopy.org/0.5/>
- OME-NGFF RFC-5 coordinate systems and transformations: <https://ngff.openmicroscopy.org/rfc/5/>
- MDN `SharedArrayBuffer`: <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer>
- MDN COEP header: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy>
- MDN COOP header: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy>
- MDN `GPUSupportedLimits`: <https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits>
- MDN `GPUDevice.createTexture()`: <https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createTexture>
