---
type: Gotcha
title: "At Extreme Tile Counts the Per-Entity Descriptor Buffer Is the Ceiling, Not the Atlas Byte Budgets"
description: "At ~21k+ visible tiles the render worker can throw 'Array buffer allocation failed' in memory-constrained (headless) browsers. The driver is the per-entity descriptor buffer — O(visible members × channels), uncapped, rebuilt every cold-state frame, and bound whole as a STORAGE buffer — not the bounded 64/512 MB atlas texture budgets."
tags: [lucida, gotcha]
source_path: wiki/gotchas/descriptor-buffer-extreme-tile-count.md
created: 2026-07-10
modified: 2026-07-10
---

# At Extreme Tile Counts the Per-Entity Descriptor Buffer Is the Ceiling

## The footgun

Opening a very large collection (~21,000+ visible members/tiles in 2D/slice
mode) can make the GPU render worker throw **`Array buffer allocation failed`**
in a memory-constrained browser — observed in **headless Chrome**. It is easy to
assume the GPU atlas *texture* budgets (`SLICE_ATLAS_BUDGET` 64 MB,
`VOLUME_ATLAS_BUDGET` 512 MB) are the wall. They are not: those are bounded and
clamped (`renderer/atlasSizing.ts`), and their slot bookkeeping is fixed by the
budget, independent of tile count.

## What actually scales with tile count

The **per-entity descriptor buffer** (`renderer/descriptorBuffer.ts`,
`buildDescriptorBuffer`) is the one large contiguous `ArrayBuffer` that grows
with the visible set: `entityCount × DESCRIPTOR_ENTRY_SIZE`, where
`entityCount = visible members × visible channels` and
`DESCRIPTOR_ENTRY_SIZE = 864 B` (`renderer/descriptor/layout.ts`). At 21k tiles
that is ~17 MiB single-channel, ~52 MiB at 3 channels. It is **rebuilt in full
on every cold-state delta** (pan/zoom go through `applyColdStateDelta` →
`applyColdState` → `buildDescriptorBuffer`), so it also **churns** that many MiB
per interaction frame — a heap-fragmentation driver in a tight allocator. The
per-LOD **indirection** buffers are similarly O(Σ grid cells), not byte-capped.

## Why the 21k case is environment-specific

17 MiB (even 52 MiB) is trivial for a real client's JS heap, which is why real
browsers render 21k tiles statically. The headless `Array buffer allocation
failed` is a **constrained-heap / fragmentation artifact** of a low-memory
headless environment, aggravated by the per-frame churn — not a real-client bug
at 21k. Profile these paths at retina scale too (see
[retina-dpr2-render-verification](retina-dpr2-render-verification.md)); the
backing-store size compounds per-frame pressure.

## The real, hard ceiling (unlimited RAM will not save you)

The descriptor is bound **whole, as a single `STORAGE` buffer**
(`renderer/sliceRenderer.ts`), so it is **unpageable** — every visible tile's
entry must be resident and bound in one buffer. That means the true limits are
the WebGPU device limits, which a min-spec device sits at:

- `maxStorageBufferBindingSize` (spec minimum 128 MiB) → **~155,000 entities**
  → a GPU validation error **even with unlimited RAM**.
- `maxBufferSize` (256 MiB) → ~310,000 entities.

So the ceiling is the STORAGE binding limit, reached long before the atlas
texture budgets matter.

## What NOT to do (the false fix)

Do **not** cap the active-set / descriptor entries, and do not lower the
render-pass aggregation threshold to force fewer entries. Both **drop visible
tiles**, regressing the real-browser 21k-static render that works today — buying
a headless-only number at the cost of real-client capability. Raising a heap
"headroom" constant is equally a non-fix: it does not move the STORAGE-binding
ceiling.

## The real fix is a design change

Rendering very large collections on genuinely low-memory clients needs a
**design** change, not a constant:

- A **paged / streaming descriptor** so not every visible tile's entry is
  resident at once, or
- A **slimmer per-tile descriptor** for aggregated overview tiles — the 864 B
  entry is dominated by `lods[8]` (512 B) + two chunk-tier sources (128 B) that
  an overview tile showing a single LOD never uses.

A related opportunity: the intensity chunk atlas, the proxy atlas, and the
bricked label atlas are three parallel slot-grid atlases whose allocation +
out-of-memory handling could share one **guarded-allocation primitive** (see
also the deferred async byte-OOM handling for the label atlas). Tracked under
**lucida-8km** and its follow-ups.

## Cheap, safe mitigation (tracked separately; not a class fix)

`buildDescriptorBuffer` allocates a **fresh** `ArrayBuffer` on every rebuild.
Reusing a persistent scratch `ArrayBuffer` (grown only when the entity count
grows, uploading only the used byte range) removes the per-frame churn — a
byte-identical fragmentation mitigation. It does **not** move the ceiling, so it
is tracked as a follow-up rather than sold as a fix.

## Interactions

- [retina-dpr2-render-verification](retina-dpr2-render-verification.md) —
  per-frame budgets compound with the retina backing store; profile at DPR 2.
- The bricked label volume atlas (`renderer/volume/atlas.ts`) is a *bounded*
  slot-grid atlas by contrast — its residency is capped by the byte budget,
  where the descriptor buffer is not.
