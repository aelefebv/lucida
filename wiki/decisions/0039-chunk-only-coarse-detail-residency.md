---
type: Decision
title: "Chunk-only coarse/detail residency"
description: "Lucida's fallback/residency model moves to two canonical chunk tiers:"
tags: [lucida, decision]
source_path: wiki/decisions/0039-chunk-only-coarse-detail-residency.md
created: 2026-05-18
modified: 2026-05-18
---

# Chunk-only coarse/detail residency

Status: Accepted

## Decision

Lucida's fallback/residency model moves to two canonical chunk tiers:

- `coarse` — a bounded per-image or per-field representation used for spatial
  context and fallback.
- `detail` — the selected source pyramid level for inspection around the active
  viewport.

Both tiers are chunks. The end state has no active field-proxy or well-proxy
fallback path. Planning, CPU cache, upload, worker protocol, GPU residency,
descriptor state, shaders, telemetry, and debug surfaces should carry tier
meaning explicitly instead of inferring fallback behavior from proxy catalogs or
promotion-mode names.

Detail defaults to source level 0, the highest-resolution source level. Users
must explicitly choose a lower source detail level if they want less resolution
or wider detail coverage. Memory pressure must not silently lower the detail
LOD; under pressure, the system adapts by spatial coverage and eviction policy
and reports sparse detail to the user.

Shader fallback order becomes selected detail, then coarse, then blank.
`overview` may exist as a migration alias, but new concepts should use
`coarse`.

Wells remain layout/grouping concepts. Residency may be decided and scheduled
per field/image, not per well. This supersedes the proxy-era rule that a plate
well is the residency/promotion unit.

PRD: #672.

## Why

Chunks are the durable storage, fetch, decode, upload, and shader-addressing
unit. The proxy fallback model introduced a parallel asset class with its own
catalog, generation path, cache, upload messages, atlases, descriptors, and
shader fallback logic. That duplication made fallback behavior harder to budget
and harder to reason about, especially once large plates exposed far more proxy
candidates than GPU memory could hold.

A chunk-only model keeps fallback in the same pipeline as detail. The renderer
can ask for "coarse chunk" and "detail chunk" instead of mixing chunk requests
with proxy assets and catalog degradation. This honors
[Principles — Planning Domain](../principles/planning.md#2-memory-is-the-binding-constraint) because each tier has
an explicit budget and eviction policy. It also honors
[Principles — Planning Domain](../principles/planning.md#4-planning-is-pure-carry-forward-state-is-explicit)
because tier selection and priority remain planner-visible inputs/outputs rather
than hidden worker state.

The highest-resolution default is a product requirement. Microscopists expect
inspection to begin at the best available source resolution; lowering detail LOD
is an explicit user choice, not an automatic memory-pressure response.

Planning still consumes WASM-produced visibility and sizing data, honoring
[Principles — Planning Domain](../principles/planning.md#5-wasm-owns-truth-planning-consumes-a-snapshot). Priority
lanes and prefetch remain bounded ways to anticipate pan/zoom/T/Z/channel
changes, honoring
[Principles — Planning Domain](../principles/planning.md#6-anticipate-the-users-likely-next-gesture) under the
memory bound.

This decision intentionally relaxes
[Principles — Planning Domain](../principles/planning.md#3-wells-are-coherent-visual-units) for residency. The old
well-as-unit rule was appropriate for proxy promotion modes, where a well proxy
was itself the fallback asset. In the chunk-only model, fields already have
their own image chunks and can be scheduled independently while the well remains
the user's layout/navigation unit.

## Consequences

- Planning emits tier-labeled chunk requests for `coarse` and `detail`.
- The three promotion modes (`well-as-proxy`,
  `fields-with-proxy-fallback`, `fields-with-detail`) are retired in the new
  path.
- Catalog degradation by proxy availability no longer controls fallback
  availability in the new path.
- CPU and GPU residency maintain separate coarse/detail memory buckets so one
  tier cannot evict the other.
- Fetch/decode/upload capacity may be shared elastically between tiers when one
  tier has no work.
- Wanted-set and upload messages carry tier labels.
- Worker routing maps each rendered member to independent detail and coarse
  pool/indirection state.
- Main renderer and minimap may share coarse CPU chunks, but keep separate
  GPU/upload residency. The minimap reads the explicit coarse level instead of
  assuming the last pyramid level.
- The UI needs an explicit per-dataset detail-level control and a passive sparse
  detail notice for huge chunks or budget-driven sparse high-res coverage.
- Proxy compatibility is temporary. After the bridge period, proxy protocol
  types, proxy stores, proxy atlases, proxy descriptors, proxy shader fallback,
  proxy debug panels, and proxy planning modes should be deleted.

## How this decision should show up in code

- `lucida-core` / WASM scene queries expose the visibility and expanded-region
  data planning needs; JS planning does not recompute camera geometry.
- `lucida-web` planning emits `coarse` and `detail` chunk requests with explicit
  lanes, priorities, and selected levels.
- `lucida-web` fetch/cache/upload code stores and delivers tier-labeled chunks
  with separate residency budgets and tier-aware telemetry.
- `lucida-web` renderer worker state represents detail and coarse chunk sources
  separately in cold state, wanted sets, descriptors, indirection, and shader
  fallback.
- Saved-view and viewport settings represent a nullable per-dataset detail-level
  override, where null/absent means highest-resolution source level.

## Related

- [Principles — Planning Domain](../principles/planning.md#2-memory-is-the-binding-constraint)
- [Principles — Planning Domain](../principles/planning.md#3-wells-are-coherent-visual-units)
- [Principles — Planning Domain](../principles/planning.md#4-planning-is-pure-carry-forward-state-is-explicit)
- [Principles — Planning Domain](../principles/planning.md#5-wasm-owns-truth-planning-consumes-a-snapshot)
- [Principles — Planning Domain](../principles/planning.md#6-anticipate-the-users-likely-next-gesture)
- Supersedes the new-path behavior in [Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)](0004-multi-pool-atlases.md)
- Supersedes the new-path behavior in [Catalog Degradation Steps One Tier at a Time](0024-catalog-degrade-one-tier-at-a-time.md)
- Supersedes the new-path behavior in [Wells Are the Planning Unit on Plates](0025-wells-as-planning-unit.md)
- Supersedes the new-path behavior in [Budgeted proxy GPU residency](0038-budgeted-proxy-gpu-residency.md)
- PRD #672
- Issue #561
