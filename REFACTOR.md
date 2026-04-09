# Virtual Texturing Refactor

Incremental migration from per-dataset multi-pass rendering to a virtual texturing architecture.

Each phase is independently shippable and testable. The rendering output should be visually identical after each phase — these are architectural changes, not feature changes.

## Current State

- One 3D atlas texture per (dataset, channel) pair
- Per-atlas indirection buffer mapping chunk grid coords to atlas slots
- Multi-pass rendering: one volume ray-march pass + one compositor pass per layer (channel × dataset)
- N channels × M datasets = N×M render passes + N×M compositor passes per frame
- Per-dataset LOD selection, no cross-dataset chunk budget
- Separate upload state per dataset/channel

## Phase 1: Shared Texture Cache

**Goal:** Replace per-dataset atlases with a shared pool of cache textures, grouped by (chunk_size, texel_format). Rendering stays multi-pass — this phase only changes data management.

**What changes:**
- A small set of large 3D cache textures replaces the per-dataset atlas textures, grouped by (chunk_size, texel_format)
- Each cache texture has uniformly-sized slots; sized based on current chunk plan demand, allocated via try-and-fallback against a global GPU memory budget
- New cache textures are created on demand when a dataset with a new chunk configuration is loaded
- Page table entries change format: packed uint32 encoding (cache_texture_index, slot_index) instead of bare slot index. Top 4 bits = texture index (15 = sentinel/not loaded), bottom 28 bits = slot index
- Page table buffers remain per-volume (one indirection buffer per dataset/channel, as today). Consolidation into a single global buffer is deferred to Phase 4 when the shader needs multi-volume access in a single pass
- Each cache texture has its own free list for slot allocation/eviction
- Chunk planning in lucida-core stays per-dataset (`chunk_plan_for()`); the JS-side interleaving in `tickCommon.ts` continues to merge plans for fetching. The unified priority-ordered plan from lucida-core is deferred to Phase 3.
- Upload loop enforces a single shared per-frame byte budget across all datasets (instead of implicit per-dataset budgets)

**What doesn't change:**
- Rendering is still multi-pass (one pass per channel per dataset)
- The shader still samples one atlas per pass — it just happens to be a shared cache texture instead of a per-dataset atlas
- LOD selection, frustum culling, and chunk fetching logic stay in their current locations

**Verification:** Visual output is identical. The same chunks are loaded and displayed, just stored in shared textures instead of per-dataset ones. Performance should be neutral or slightly better (unified upload budget, simpler eviction).

## Phase 2: Single-Pass Multi-Channel Shader

**Goal:** Replace multi-pass per-channel rendering with a single ray march that composites all channels at each step.

**What changes:**
- Volume shader takes a list of channel descriptors (colormap, contrast, gamma, blend mode) via storage buffer
- Shader loops over active channels at each ray step, sampling from the cache via the page table
- Per-channel contrast/gamma/colormap applied in-shader
- Channel compositing (additive, max, alpha) happens per-step, not between passes
- The compositor pass is eliminated for multi-channel volumes
- Volume descriptor storage buffer introduced: transforms, channel count, channel offset, page table offset per volume
- Channel descriptor storage buffer: per-channel display settings

**What doesn't change:**
- The texture cache from Phase 1 (same data management)
- One draw call per dataset (multi-volume comes in Phase 4)
- Page table structure (same layout, shader just reads it for multiple channels now)
- LOD fallback behavior

**Open question:** Channel count upper bound for the shader loop. Multiplex IF experiments can have many channels. A uniform-driven loop with a compile-time max (16? 32?) is simpler than shader permutations and handles the variable count naturally.

**Verification:** Visual output is identical. Same channels, same colormaps, same compositing — just done in one pass instead of N. Frame time should drop roughly proportional to channel count (eliminating redundant ray marches).

## Phase 3: Page Table LOD Fallback

**Goal:** Replace per-dataset LOD selection with per-chunk progressive refinement via the page table.

**What changes:**
- Page table has entries for each LOD level per volume, each with its own chunk grid dimensions
- Shader performs a fallback chain: try target LOD, if sentinel try coarser, repeat until resident data found
- Seed data (coarsest LOD) is effectively pinned in the cache — always loaded first, never evicted under normal conditions
- lucida-core's chunk plan becomes LOD-aware: priorities account for LOD level, with seed data highest
- lucida-core produces a single unified priority-ordered plan across all visible volumes (replacing the current per-dataset `chunk_plan_for()` calls that get interleaved on the JS side). Cross-dataset priority decisions (e.g., seed data for volume A vs fine data for volume B) are made in core, not in JS orchestration.
- Mixed-LOD rendering within a single volume becomes possible (nearby chunks at fine LOD, distant at coarse)

**What doesn't change:**
- The texture cache and grouping from Phase 1
- The single-pass multi-channel shader from Phase 2
- Frustum culling

**Open question:** Page table layout for multi-LOD. Each LOD level has a different grid size (coarser = smaller grid). Options: contiguous regions per LOD within each volume's page table section (simple, volume descriptor stores offset per LOD), or interleaved. Contiguous is simpler.

**Verification:** When all fine-LOD chunks are loaded, output is identical. Progressive behavior is new and visible — volumes should appear coarse immediately and sharpen as fine chunks arrive. Scrubbing T should show coarse → fine transitions instead of black → loaded.

## Phase 4: Multi-Volume Ray March

**Goal:** Extend the shader to handle multiple overlapping volumes in a single ray march.

**What changes:**
- Per-volume page table buffers consolidated into a single global page table buffer, with each volume assigned a contiguous region addressed by offset. This is necessary because the shader now accesses multiple volumes' page tables in a single pass.
- Shader receives a list of volume descriptors (transforms, AABBs, channel info, page table offsets into the global buffer)
- At each ray step, the shader tests which volumes contain the current position (AABB check)
- For each volume at that step, samples all its channels via the global page table and composites
- Volume-to-volume compositing (how overlapping volumes blend at a given step) is a new operation
- For plate layouts, the regular grid structure can be exploited — the shader computes which field/well a position falls in arithmetically instead of testing all volumes
- Frustum culling on the CPU determines which volume descriptors are passed to the shader each frame
- One draw call, one render pass for the entire scene regardless of volume count

**What doesn't change:**
- The texture cache from Phase 1
- The per-channel compositing from Phase 2
- The LOD fallback from Phase 3

**Open question:** Volume-to-volume blend mode at overlap boundaries. For field stitching, averaging or feathered blending in the overlap region makes sense. For independent datasets overlaid on each other, additive or alpha compositing. This may need to be configurable per volume pair or per overlap region.

**Verification:** For non-overlapping datasets, output is identical (each pixel's ray only hits one volume). For overlapping fields, the overlap region should blend smoothly instead of rendering one field on top of the other. Performance should improve for multi-dataset scenes (one draw call instead of M).

## Open Design Questions (Cross-Phase)

### 2D path
The 2D slice rendering path should share the same virtual texturing infrastructure (page table, residency analysis, priority logic, cache management). The only difference is the cache uses 2D textures instead of 3D, and the shader is a simple textured quad instead of a ray march. This is a parallel effort that can proceed alongside any phase.

### Volume metadata GPU layout
The volume and channel descriptor buffers need a concrete layout. Rough shape:
- **Volume descriptor:** world_to_local matrix, AABB, channel count, channel offset, page table offset, LOD count, chunk grid dims per LOD
- **Channel descriptor:** colormap index, contrast min/max, gamma, blend mode

### Per-channel blend modes
With multi-channel compositing inside the shader (Phase 2+), blend mode becomes per-channel rather than per-layer. Multiplex IF experiments may want mixed blend modes within a single volume (e.g., additive for most channels, max for a specific marker). This should be a field on the channel descriptor.

### Scrubbing and cache transitions
Dimension transitions (T/C/Z) interact with the cache across all phases. The core rules:
- Don't evict old data until new data replaces it in the page table
- Debounce rapid scrubbing — only fetch for the latest requested value, drop intermediate requests
- Prefetch adjacent Z aggressively (fastest scrub), T±1 at seed LOD (medium), C not prefetched (rare)
These rules apply regardless of which phase the renderer is at.

### Shared CPU cache budget
The CPU-side fetch cache (`SharedChunkQueue`) is currently 512 MB per dataset. With many datasets loaded (e.g., plate fields), total CPU memory could grow unbounded. Consider unifying to a shared CPU cache budget, mirroring what Phase 1 does for the GPU cache. The tiered cache model (CPU cache as fetch-cost buffer, GPU cache as render-priority buffer) is correct — the issue is just that the CPU tier's budget should be global, not per-dataset.
