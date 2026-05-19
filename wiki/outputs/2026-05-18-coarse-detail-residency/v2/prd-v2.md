# PRD v2: Chunk-only coarse/detail residency

Parent PRD: #672
Source issue: #561
Design notes: `wiki/outputs/2026-05-18-coarse-detail-renderer-grill.md`

## Problem Statement

Lucida needs one coherent fallback model for large microscopy datasets. The
current proxy/radius fallback path keeps views from going blank, but it does so
through a second asset class with separate catalogs, generation, cache stores,
GPU atlases, descriptors, shader fallback, and well-level promotion behavior.
That makes fallback hard to reason about, hard to budget, and inconsistent with
the storage model where chunks are the durable unit.

Users need the highest source resolution by default for scientific inspection,
while also keeping bounded spatial context when high-resolution chunks are too
large or slow to cover the whole view. Memory pressure must not silently lower
detail. If only a few high-res chunks can be resident, Lucida should show the
available detail, keep coarse fallback underneath missing detail, and explain
the sparse-detail state.

The first bridge implementation proved the model but exposed a renderer
limitation: detail and coarse can only share the path when their chunk shapes are
compatible. The complete implementation must support arbitrary source coarse
chunk shapes, generated coarse levels, protected tier residency, cancellation,
readiness, collaboration, and proxy retirement.

## Solution

Replace proxy fallback with two first-class chunk tiers:

- `detail`: exactly one selected source pyramid level. It defaults to source
  level 0 and changes only through explicit user choice.
- `coarse`: the configured coarse level for the image or field. It may be an
  existing source level that fits coarse bounds, or a server-generated derived
  level in Lucida's derived cache.

The renderer uses one draw path with simultaneous detail and coarse chunk
sources. For each pixel or ray sample, the shader samples selected detail first.
If the detail chunk is absent at that coordinate, it samples coarse at the
coarse tier's own level dimensions and chunk dimensions. If both are absent, it
renders blank. There is no blending and no implicit fallback through
intermediate source LODs.

CPU cache, upload, worker protocol, GPU residency, descriptors, shaders,
planning, minimap, telemetry, and debug surfaces carry tier meaning explicitly.
GPU residency has protected coarse/detail buckets. CPU decoded-byte cache has
protected coarse/detail minimums with elastic surplus borrowing. Fetch, decode,
and upload throughput gives each tier its standard allocation while both tiers
have demand, and uses elasticity only when one tier is idle.

Generated coarse is server-mediated. Dataset open does not wait for generation.
Generated metadata may be published before chunks are ready; readiness is
per-chunk and server-authored. Current visible generated coarse work takes
priority over predicted work, which takes priority over bounded background fill.
The generation service is server-wide, fair across datasets/clients, deduped by
source/config/image/chunk identity, cancellable at safe boundaries, and backed
by an atomic derived cache with restart/reopen recovery.

After source-backed and generated coarse reach parity, coarse/detail becomes the
default path and proxy fallback is deleted or isolated as unreachable legacy
with a tracked removal path.

## User Stories

1. As a microscopist, I want the viewer to default to highest-resolution source
   detail, so that scientific inspection starts from the data I expect.
2. As a microscopist, I want lower detail to be an explicit choice, so that
   memory pressure does not silently reduce the resolution I am evaluating.
3. As a microscopist, I want sparse high-resolution chunks to appear wherever
   available while coarse context fills missing regions, so that I can inspect
   detail without losing spatial orientation.
4. As a microscopist, I want sparse-detail info/logging when high-res coverage
   is low, so that I understand why only a few large chunks are visible.
5. As a microscopist, I want sparse-detail messaging to point to the lower-detail
   control, so that I have an explicit action without changing the default.
6. As a plate viewer, I want plates and single-image datasets to share the same
   tiered chunk model, so that fallback behavior is consistent.
7. As a plate viewer, I want generated coarse per field/FOV rather than per
   aggregated well, so that generation follows the actual image storage unit.
8. As a plate viewer, I want well layout/grouping to remain intact even when
   residency is per field, so that plate navigation stays coherent.
9. As a user opening a huge dataset, I want dataset open to complete before
   generated coarse finishes, so that fallback generation does not block access.
10. As a user reopening an unchanged dataset, I want generated coarse chunks to
    be reused, so that Lucida does not regenerate unchanged derived data.
11. As a user with server-local source files, I want generated coarse written
    only to Lucida's derived cache, so that source data is never mutated.
12. As a user on a direct/non-server-mediated dataset, I want source-backed
    coarse when available and clear unavailable state otherwise, so that browser
    paths do not pretend generated coarse exists.
13. As a user scrubbing time, I want stale generation, fetch, decode, and upload
    work to stop blocking the current T, so that scrubbing remains responsive.
14. As a user scrubbing Z, I want current Z work to outrank stale nearby work, so
    that the active plane becomes useful promptly.
15. As a user toggling channels, I want newly visible channels to receive
    scheduling priority, so that hidden-channel work does not block the view.
16. As a user panning or zooming, I want both coarse and detail prediction around
    likely next views, so that movement does not collapse to blank.
17. As a user panning or zooming, I want coarse fallback protected from detail
    churn, so that context remains available while detail changes.
18. As a user looking at the minimap, I want it to use explicit coarse metadata,
    so that it does not guess from the last source level.
19. As a user looking at the minimap, I want minimap GPU/upload residency
    separate from the main view, so that minimap broad fill cannot evict main
    fallback or detail.
20. As a collaborator joining a session, I want cached/generated metadata and
    readiness included in dataset-open state, so that I do not need to witness
    old deltas.
21. As a collaborator, I want generated readiness from another user's interest
    to broadcast to my client too, so that shared generated chunks help everyone.
22. As a user saving a view, I want explicit detail overrides preserved and stale
    overrides clamped to source levels, so that saved views remain meaningful.
23. As a user saving the default view, I want null/absent detail override, so
    that saved views do not freeze default level 0 unnecessarily.
24. As an operator, I want generated coarse concurrency, background fill, cache
    root, and disk budget configurable, so that resource usage is predictable.
25. As an operator, I want generated coarse cache eviction to touch only derived
    artifacts and maintain readiness correctness, so that source data is safe.
26. As an operator, I want telemetry for client residency and server generation,
    so that memory pressure, sparse detail, backlog, failures, and reuse are
    diagnosable.
27. As a renderer developer, I want clean chunk-tier shader bindings and
    descriptor fields, so that proxy semantics do not leak into the new path.
28. As a renderer developer, I want arbitrary detail/coarse chunk shapes
    supported, so that source coarse levels work without compatibility guards.
29. As a renderer developer, I want no implicit coarser-detail fallback, so that
    the new path means selected detail, then configured coarse, then blank.
30. As a cache developer, I want stale completed bytes to cache opportunistically
    without uploading or evicting protected current tiers, so that scrubbing can
    reuse work without harming the current view.
31. As a server developer, I want generated coarse jobs deduped by source
    content, generated level, image/field, T/C/chunk, and config, so that
    clients share in-flight and completed work.
32. As a server developer, I want atomic publish ordering before readiness
    broadcast, so that clients never observe ready chunks the resolver cannot
    serve.
33. As a server developer, I want pending/unavailable/transient-failed/
    permanent-failed/ready statuses, so that clients schedule and retry
    correctly.
34. As a maintainer, I want proxy fallback retired after parity, so that Lucida
    has one fallback model instead of two overlapping systems.

## Implementation Decisions

- Two tiers, `coarse` and `detail`, are canonical. A third `medium` tier remains
  out of scope.
- Detail means exactly one selected source level. Default null/absent detail
  override means source level 0. Numeric overrides are explicit user choices and
  clamp to source levels only.
- Generated coarse is not a normal user-selectable detail level by default.
- `MultiscaleInfo` owns the coarse pointer and generated-level metadata. Level
  geometry remains geometry-only.
- Generated levels append after source levels or otherwise use unique numeric
  level indices that do not collide. Numeric level index is not the durable
  generated cache identity.
- If no valid coarse pointer exists, the renderer plans/renders selected detail
  only and reports missing or pending coarse capability. It must not guess
  `levels.length - 1`.
- Source-backed coarse is allowed for direct/non-server-mediated datasets. If no
  valid source coarse exists outside server mediation, generated coarse is
  unavailable for this implementation.
- Generated coarse requires server mediation and a Lucida derived cache. Lucida
  never writes generated data into source Zarrs or server-local source paths.
- Source level selection uses an existing source level directly if it satisfies
  coarse bounds. Otherwise generation chooses the nearest finer available source
  level above target coarse resolution, falling back to the next finer level as
  needed.
- A source level fits if it satisfies configured max long axis, max decoded
  bytes per image/field/channel/timepoint, renderer/device chunk sanity, and
  optional max chunk count. Z is preserved unless bounds require physical-scale
  or anisotropy-aware downsampling.
- Generated output chunk shape is chosen by Lucida from bounded generator config
  rather than copied blindly from source.
- Generated cache identity includes source content identity, canonical image or
  field identity, input level/scope, output geometry/chunk shape/dtype,
  downsample algorithm/version, coarse config version, generator version, and a
  derived-level identity.
- Job dedupe key includes source content id, generated level id, canonical
  source image/field id, T, C, generated chunk key, and generation config id.
  Plates use field/FOV image ids, not parent well ids.
- Dataset open does not wait for generation. Generated-level metadata may be
  published before any generated chunks are ready.
- Readiness is per chunk. Level-level summaries are telemetry only.
- Pending generated coarse is a first-class non-error state. It does not enter
  chunk failure tracking or immediate retry loops.
- Generated status distinguishes pending, unavailable, transient failure,
  permanent failure, and ready.
- Atomic publish order is temp write, validation, flush/close where practical,
  atomic move into the final derived-cache path, resolver-visible readiness
  update, then readiness broadcast.
- Derived cache uses sidecar manifest/index plus atomic chunk files. The index
  is the fast path; scan/validation can rebuild when missing or stale.
- Derived cache is authoritative across late join, reopen, and server restart.
  In-memory generation service state is an acceleration layer.
- Derived cache eviction is automatic under disk budget, starts at whole
  generated-level identity granularity, touches only generated artifacts, and
  atomically updates readiness if active ready data is evicted.
- Generated metadata/readiness deltas are server-authored runtime availability,
  not document commands, not saved-view content, and not proxy catalog deltas.
- Readiness deltas broadcast to all clients in a session with the dataset open.
- Viewer-interest hints are unsequenced advisory session messages with client,
  dataset, generation, T/Z, channels, mode, viewport or desired keys, interaction
  mode, predicted keys, timestamp, and TTL.
- Multiple clients' interest merges by priority lane with per-client replacement
  and TTL. Duplicate chunks take their highest lane. Caps or weighted admission
  prevent one client from dominating.
- Server generation is owned by one server-wide service. It owns global
  concurrency, fair scheduling, job dedupe, priority lanes, cancellation tokens,
  readiness, cache identity, background fill caps, and telemetry.
- Server generation uses strict priority classes within weighted fair dataset
  scheduling: visible, predicted, then background. Background fill runs only
  when active visible/predicted work is absent or via operator-configured
  trickle.
- Prediction/reprioritization covers XY pan/zoom, Z scrubbing, T scrubbing, and
  channel changes for both coarse and detail. Chosen to honor
  [[principles/planning#6-anticipate-the-users-likely-next-gesture]] within
  memory bounds.
- Cancellation/reprioritization applies at every queued boundary: pending fetch,
  pending decode, pending deliverable/upload, worker stale epoch checks, and
  generated coarse server work. Running work is interrupted only at safe
  boundaries.
- Stale completed fetch/decode results may cache as low-priority/demoted entries
  if they do not evict protected current coarse/detail minimums. They must not
  upload while stale.
- Planning stays pure over snapshot, explicit carry-forward state, and config.
  Chosen to honor
  [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]].
- Planning consumes WASM-produced visibility, bounds, and sizing rather than
  re-deriving geometry in JS. Chosen to honor
  [[principles/planning#5-wasm-owns-truth-planning-consumes-a-snapshot]].
- Residency may be per image/field rather than per well. This intentionally
  relaxes [[principles/planning#3-wells-are-coherent-visual-units]] for
  residency while keeping wells as layout/navigation units.
- GPU residency has protected coarse/detail buckets with no cross-tier eviction.
  Chosen to honor [[principles/planning#2-memory-is-the-binding-constraint]].
- CPU decoded-byte cache has protected coarse/detail minimums with elastic
  surplus borrowing. Borrowed bytes evict first when the owner tier needs its
  protected budget.
- Fetch/decode/upload throughput gives coarse and detail their standard
  allocations when both have demand. Elasticity is used only when a tier is
  idle.
- Scheduling uses tier-specific lanes: `coarse-visible`, `detail-visible`,
  `coarse-predicted`, `detail-predicted`, `coarse-background`, and optional
  tiny/off-by-default `detail-background`.
- Renderer uses one draw path with simultaneous detail and coarse chunk sources.
- Descriptor and shader bindings are clean chunk-tier concepts. Do not reuse
  proxy binding slots or proxy field names in the new path.
- Shader fallback is strict replacement: selected detail, then configured
  coarse, then blank. It uses independent levelDims/chunkDims/indirection lookup
  per tier, so chunk sizes may differ.
- Do not blend or smooth detail/coarse boundaries initially. Use telemetry,
  chunk-grid/debug overlays, and sparse-detail messaging instead.
- Minimap may share decoded CPU coarse bytes with main view but keeps separate
  GPU residency and upload accounting.
- Saved views store only explicit user detail-level override state. Coarse
  pointers, generated identities, readiness, cache paths, and sparse-detail
  notice state are runtime availability.
- User UI stays minimal: detail selector, passive sparse-detail notice/log, and
  coarse status in info/debug surfaces. No initial manual generation controls.
- Feature gating uses one top-level internal client path flag for old proxy path
  versus new coarse/detail path until parity. Server generated-coarse resource
  controls are separate operator config.
- Default flip requires source-backed arbitrary chunk shapes, generated coarse,
  explicit statuses, protected residency, CPU protected minimums, minimap
  separation, sparse-detail telemetry, saved-view compatibility, restart/reopen
  reuse, automated coverage, and representative single-image/plate smoke.
- After the default flip, proxy fallback has no long-term active compatibility
  role. Proxy requests, catalogs, shader fallback, atlases/descriptors, and
  server generation should be deleted or isolated as unreachable legacy.

## Testing Decisions

- Tests should assert subsystem contracts and externally visible behavior, not
  private helper order.
- Rust metadata/protocol tests cover additive generated-level metadata, coarse
  pointers, generated status variants, dataset-open backcompat, and source-only
  detail selection.
- Store/server tests cover source-vs-derived resolution, generated cache
  identity, manifest/index recovery, atomic publish, pending/unavailable/
  failed/ready statuses, restart/reopen reuse, disk-budget eviction, and local
  source non-mutation.
- Generation service tests use fake sources/workers to cover dedupe, fair
  scheduling, visible/predicted/background priority, cancellation, tile-step
  cancellation checks, background disablement, TTL expiry, and multi-client
  interest merging.
- Web planning tests cover tier-specific lanes, arbitrary source coarse chunk
  shapes, no implicit coarse guessing, no coarser-detail fallback, prediction
  for XY/T/Z/channel, and absence of proxy requests in the new path.
- CPU cache tests cover protected minimums, elastic surplus borrowing, stale
  demoted insertion, pending non-failure behavior, per-tier queue telemetry, and
  fixed allocation with idle borrowing.
- Upload and worker protocol tests cover tier labels, pending/readiness
  re-request behavior, stale upload drops, minimap separation, and no proxy
  message use in the new path.
- GPU residency tests cover independent detail/coarse pools, arbitrary chunk
  shapes, clean descriptor layout, WGSL/TS layout locks, strict replacement
  fallback, eviction feedback by tier, and no cross-tier eviction.
- UI/state tests cover detail selector labels/defaults, saved-view persistence
  and clamping, sparse-detail notice conditions, generated/coarse status display,
  and old saved-view/settings compatibility.
- E2E or browser smoke should open representative single-image and plate
  datasets, including mismatched detail/coarse chunk shapes, verify detail where
  present, coarse where detail missing, generated readiness re-request, reopen
  reuse, and no blank-canvas regression.

## Out of Scope

- A third `medium` tier.
- Automatic detail lowering under pressure.
- Blending or smoothing detail/coarse boundaries.
- Browser-side generated coarse.
- Mutating source Zarrs or server-local source data.
- Treating generated coarse as a normal detail choice by default.
- Aggregated well-level generated assets.
- Generating intermediate/detail/super-resolution/denoised levels.
- Long-term active proxy compatibility.
- A new binary transport specifically for generated coarse bytes.
- User-facing generation controls beyond passive status and operator config.

## Further Notes

- ADR 0039, ADR 0040, and ADR 0041 capture the durable decisions behind the
  two-tier model, generated coarse levels, and the clean two-source renderer.
- Existing PRD #672 and issue slices should be updated rather than replaced by a
  competing PRD.
- The first bridge commit series should be treated as partial implementation:
  it proved tier metadata and request labeling but does not satisfy the v2
  renderer/source-backed requirements until the compatibility guard is removed.
