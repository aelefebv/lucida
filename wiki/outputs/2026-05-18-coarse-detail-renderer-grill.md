---
created: 2026-05-18
modified: 2026-05-18
---

# Coarse/detail renderer grill notes

Scope: full `/code` grill for completing coarse/detail residency after the
bridge implementation. This includes renderer residency, CPU cache policy,
generated coarse metadata/readiness/materialization, scheduling/cancellation,
default flip, proxy retirement, tests, docs, and implementation slicing.

Anchors:
- PRD #672 / PRD copy:
  `wiki/outputs/2026-05-18-coarse-detail-residency/lucida-coarse-detail-residency-prd.md`
- Slice 02: source-backed coarse/detail rendering path
- Slice 06: separate coarse/detail CPU/GPU buckets and minimap separation
- ADR 0039: chunk-only coarse/detail residency
- ADR 0040: generated coarse as derived pyramid levels
- ADR 0041: clean two-source chunk-tier renderer

Already settled:
- Two tiers: `coarse` and `detail`.
- Detail defaults to source level 0; lower detail is explicit user choice.
- Shader fallback target is selected detail, then coarse, then blank.
- Coarse/detail must be explicit tier semantics, not proxy semantics.
- Residency may be per field/image; well coherence as residency unit is
  intentionally relaxed.

Current bridge limitation:
- A member maps to one chunk atlas pool keyed by target/detail chunk dimensions.
- Detail and coarse are only both usable when their chunk shapes match that pool.
- Mismatched source coarse levels require independent tier pool routing and
  shader/descriptor changes.

Open grill thread:
- Finish the full design exploration needed to spec and implement the complete
  coarse/detail residency system.

Clarification:
- Different coarse/detail chunk sizes are expected and should be supported.
- That requires separate tier atlas textures/indirection/pool routing; one pool
  cannot safely hold both.
- Shader sampling remains position-based: map entity-local position into each
  tier's level dimensions, divide by that tier's chunk dimensions, read that
  tier's indirection, then sample that tier's atlas slot.
- Slice mode also needs explicit full-res-Z to level-Z mapping per tier so
  detail and coarse choose the correct source Z chunk independently.

Decisions:
- Use one render pass/draw path with simultaneous detail and coarse chunk
  sources, not separate coarse/detail render passes.
- Introduce an explicit tier-source abstraction in worker state/descriptors:
  each rendered member can have a `detail` source and a `coarse` source, each
  with its own pool key, texture, indirection, slot dims, LOD metadata, and
  budget.
- GPU residency uses protected coarse/detail buckets with no cross-tier
  eviction. Fetch/decode/upload capacity may be elastic when one tier has no
  work.
- Use exactly two named tier sources rather than a generic N-tier runtime
  abstraction. Keep the data shape regular enough that a later third tier would
  be additive.
- Add clean new chunk-tier shader/descriptor/bind-group bindings for detail and
  coarse rather than reusing proxy binding slots. Legacy proxy concepts should
  be cleared from the new tier path instead of surviving as renamed payloads.
- Clear renderer legacy in the new coarse/detail path now: no proxy bindings,
  proxy descriptors, or proxy shader fallback on that path. Keep full proxy
  server/protocol/cache deletion for the later default-flip/proxy-retirement
  slice, after generated coarse and parity are ready.
- The new renderer path must support source coarse levels with arbitrary chunk
  shapes immediately. Generated coarse may choose normalized/bounded chunk
  shapes later, but renderer correctness cannot depend on detail/coarse
  compatibility or generated-only coarse.
- Main renderer coarse planning requests visible/frustum-overlapping coarse
  chunks first. Nearby/predicted coarse and optional whole-coarse background
  fill are lower-priority, bounded, and cancellable rather than blocking detail
  behind full-level preload.
- Minimap and main renderer may share decoded CPU coarse chunks, but keep
  separate GPU residency and upload accounting so minimap broad fill cannot
  evict main-view fallback/detail and main-view churn cannot collapse minimap
  context.
- CPU decoded-byte cache uses protected coarse/detail minimums with elastic
  surplus borrowing. Borrowed bytes are first to evict when the owner tier needs
  its protected budget back. GPU residency remains hard protected.
- Cancellation/reprioritization applies at every queued boundary: pending CPU
  fetches, pending decodes, pending deliverables/uploads, worker stale epoch
  checks, and generated coarse server work. Running work is interrupted only at
  safe boundaries; finished stale fetch/decode work may cache but must not upload
  unless still wanted.
- Stale completed fetch/decode results may be inserted into the CPU cache as
  low-priority/demoted entries and promoted later if wanted again, but they must
  not upload while stale and must not evict protected current coarse/detail
  minimums.
- Pending generated coarse is an explicit non-error state. Pending chunks should
  not enter failure tracking or immediate retry loops; readiness deltas trigger
  normal re-request after the generated chunk becomes materialized.
- Shader fallback uses strict replacement, not blending: sample detail at the
  tier-local coordinate first; only if that detail chunk is absent, sample coarse
  at the coarse tier-local coordinate; otherwise blank. Different tier chunk
  sizes are handled by independent levelDims/chunkDims/indirection lookup per
  tier.
- Do not visually smooth detail/coarse boundaries initially. Surface detail and
  coarse wanted/resident telemetry, tier-aware chunk-grid/debug overlays, and
  sparse-detail user/log messaging instead of blending or blurring scientific
  signal.
- The new renderer path does not use old "coarser detail LODs" fallback. The
  fallback chain is exactly selected detail level, then configured coarse level,
  then blank. Intermediate source levels are not implicitly resident unless the
  user selects one as detail or metadata names one as coarse.
- If no valid coarse pointer exists, the renderer plans/renders selected detail
  only and reports missing/pending coarse capability. It must not guess a coarse
  level such as `levels.length - 1`; server/import metadata owns source coarse
  selection and generated coarse readiness.
- Generated coarse readiness is per chunk, with optional level-level summary
  telemetry. Generated level metadata may exist before all chunks are ready;
  visible/current chunks become normally requestable as soon as their readiness
  is published.
- Continue the full `/code` pipeline rather than stopping at a renderer-only
  correction. Renderer work is one part of the complete implementation spec.
- Generated coarse materialization is hybrid: dataset open does not wait; visible
  requested coarse chunks generate first, nearby/predicted work follows, and
  whole-level background fill is optional, bounded, low-priority, operator
  tunable, and cancellable.
- Generated coarse cache identity includes source content identity, image/field
  identity, selected input level/scope, output shape/chunk shape/data type,
  downsample algorithm/version, coarse constraints/config version, generator
  version, and a derived-level identity. Numeric client-facing level index is
  not sufficient as the durable cache identity.
- Generated chunk publish order is temp write, validation, flush/close where
  practical, atomic move into final derived-cache path, resolver-visible
  readiness update, then client readiness broadcast. Readiness must never be
  visible before normal chunk resolution can serve the bytes.
- Generated coarse status distinguishes pending, unavailable, transient failure,
  permanent failure, and ready. Pending is not a cache failure; transient
  failures retry with backoff; permanent failures do not spin retry loops.
- A server-wide coarse generation service owns global concurrency, per-dataset
  fairness, job dedupe, priority lanes, cancellation tokens, readiness state,
  cache identity, background fill caps, and telemetry. Jobs are not owned by
  individual sessions.
- Generation scheduling uses priority lanes within each dataset and weighted
  fair scheduling across datasets/clients. Visible work beats predicted work,
  which beats background fill. Background fill yields to visible/predicted work
  from any active dataset. Multiple clients on the same dataset merge interest.
- Viewer-interest hints are unsequenced advisory session messages, not document
  commands. They include client/session identity, dataset id, interest
  generation, T, Z/Z range, visible channels, render mode, viewport/frustum or
  desired coarse keys, interaction mode, optional predicted keys, timestamp/ttl;
  newer per-client interest supersedes older interest and hints expire/merge
  across clients.
- Generated coarse job dedupe key is source content id, generated level id,
  canonical source image/field id, T, C, Z/Y/X chunk key, and generation config
  id, plus source input level if not implied by the generated level/config.
  Single-image datasets use their image id; plates use field/FOV image ids, not
  parent well ids. Completed ready chunks dedupe by readiness/cache state and do
  not enqueue.
- Generated coarse input selection uses an existing source coarse level directly
  if it fits bounds. Otherwise generation uses the nearest finer available
  source level above the target coarse resolution, falling back to the next
  finer level if needed and recording the selected input level in provenance and
  cache identity.
- A source level fits coarse bounds when it satisfies configured max long axis,
  max decoded bytes per image/field/channel/timepoint, renderer/device chunk
  dimension sanity, and optional max chunk count for background fill. Z is not
  blindly collapsed; preserve Z unless bounds require downsampling, then use
  physical-scale/aniso-aware rules.
- Generated coarse output chunk shape is chosen by Lucida from bounded
  generator config rather than copied blindly from source. It should balance max
  decoded chunk bytes, scheduling granularity, target dimensions, and anisotropic
  Z behavior, and is recorded in generated-level metadata/cache identity.
- Generated-level metadata may be published before any generated chunks are
  ready. Readiness starts empty/pending and fills per chunk; early metadata lets
  clients plan coarse demand, show pending diagnostics, and send viewer-interest
  hints before materialization completes.
- Generated metadata/readiness deltas are server-authored runtime availability
  updates, not document commands and not saved-view content. They mutate client
  scene/runtime metadata, bump an availability/planning epoch, are server-only,
  and should not reuse proxy catalog semantics.
- The derived cache is authoritative for generated readiness across late join,
  reopen, and server restart. In-memory generation service state accelerates
  active jobs but can be rebuilt from cache metadata/readiness; corrupted or
  missing entries validate to unavailable/failed rather than silently ready.
- Derived cache uses sidecar manifest/index plus atomic chunk files. The
  manifest records identity/provenance/geometry/chunk grid; readiness index
  records ready chunk keys and status/failure metadata. Startup/open loads the
  index first and can scan/validate chunk files to rebuild if the index is
  missing or stale.
- Operator config controls generated coarse enablement, global/per-dataset
  concurrency, background fill enablement/rate, coarse fit bounds, max generated
  chunk bytes/shape, derived cache root/disk budget, and retry/backoff policy.
  Downsample algorithm and arbitrary per-dataset coarse config are not initially
  user-facing.
- Derived cache eviction is automatic under a disk budget, touches only
  generated artifacts, avoids active-session chunks unless under hard pressure,
  and updates readiness/availability atomically if active ready chunks are
  evicted. Source data is never touched.
- Disk-budget eviction starts at whole generated-level identity granularity.
  Partial chunk cleanup is allowed for failed/pending job cleanup, but normal
  budget eviction should avoid per-chunk ready-state churn unless later evidence
  demands it.
- Generated coarse for server-local file datasets is always written to Lucida's
  derived cache, never next to or inside the user's/source dataset. Saved views
  do not reference derived cache paths; clearing the cache leaves source data
  unchanged and makes coarse pending/unavailable again.
- Saved views store only explicit user detail-level override state. Coarse
  pointers, generated level identities, readiness/pending/failure state, derived
  cache paths, and sparse-detail notice state are runtime availability and do
  not serialize into saved views.
- Generated metadata/readiness deltas broadcast to all session clients with the
  dataset open, not only the client whose interest triggered generation.
  Viewer-interest hints remain per-client advisory inputs.
- Multiple clients' viewer interest merges by priority lane with per-client
  replacement and TTL. Visible keys union across clients, predicted keys union
  separately, duplicate chunks take their highest lane, and per-client caps or
  weighted admission keep one client from dominating active interest.
- Prediction/reprioritization covers XY pan/zoom, Z scrubbing, T scrubbing, and
  channel changes for both coarse and detail rendering. The policy is shared,
  but applied within tier-specific budgets/lanes so detail responsiveness does
  not evict protected coarse fallback and coarse fill does not starve current
  detail.
- Scheduling uses the same conceptual lanes with tier-specific instances:
  `coarse-visible`, `detail-visible`, `coarse-predicted`, `detail-predicted`,
  `coarse-background`, and optional/limited `detail-background`. Detail
  background should be disabled or tiny by default; detail prediction is useful
  for T/Z/channel/near-viewport responsiveness.
- When coarse and detail both have requests, each tier receives its standard
  fetch/decode/upload allocation; cross-tier elasticity is used only when one
  tier has no demand. This avoids surplus-priority coupling between
  `coarse-visible` and `detail-visible` while preserving deterministic
  protected progress for both tiers.
- Server generated-coarse workers use strict priority classes within weighted
  fair dataset/client scheduling, not fixed class allocations. Visible generated
  work can consume all available generation workers until drained; predicted
  follows; background fill runs only when active visible/predicted work is
  absent or via an operator-configured trickle.
- Generation is strictly for coarse fallback in this feature. Detail levels are
  source levels selected by the user; generated coarse is not a normal
  user-selectable detail level by default and this work does not generate
  intermediate/medium/detail levels.
- User-facing UI stays minimal: detail source-level selector, passive
  sparse-detail notice/log with lower-detail control as the direct action, and
  coarse status in info/debug surfaces. No initial "generate coarse now",
  generated-cache management, downsample algorithm, or per-dataset generation UI.
- Telemetry splits into client residency and server generation. Client telemetry
  covers desired/resident chunks/bytes by tier, detail/coarse visible coverage,
  generated status counts, per-tier CPU/GPU bytes/evictions, per-tier
  fetch/decode/upload queue depth, stale canceled/dropped counts, and
  sparse-detail sustained notices. Server telemetry covers job queues/running/
  completed/failed/canceled by lane, latency, dedupe/cache reuse, derived-cache
  bytes/evictions, readiness broadcasts, and per-dataset fairness/backlog.
- Test strategy relies on deterministic unit/integration coverage across Rust
  metadata/protocol/cache/resolver/scheduler, web planning/cache/upload/worker,
  descriptor WGSL layout locks, saved-view compatibility, and minimap behavior,
  plus one focused browser/GPU smoke if tooling is stable enough.
- Existing PRD #672 and slice artifacts should be revised as v2 rather than
  creating a competing spec. The v2 update must fold in clean tier bindings,
  arbitrary source coarse chunk shapes, elastic CPU protected minimums, fixed
  per-tier client transfer allocations, strict-priority server generation,
  sidecar cache indexes, whole-level disk eviction, and explicit status
  semantics.
- Feature gating uses one top-level internal client path flag for old proxy path
  versus new coarse/detail chunk-tier path until parity. Server generated-coarse
  resource controls remain separate operator config for enablement, concurrency,
  background fill, and cache budget.
- Default flip requires arbitrary-shape source coarse, generated coarse
  metadata/readiness/materialization for server-mediated datasets, explicit
  pending/unavailable/failed statuses, protected coarse/detail GPU residency,
  CPU protected-minimum elastic cache, minimap separation, sparse-detail
  telemetry/notice, saved-view backcompat, restart/reopen cache reuse, automated
  coverage, and representative browser/manual smoke for single-image and plate
  datasets.
- After the default flip, proxy fallback has no long-term active compatibility
  role. Planner proxy requests/catalog fallback, proxy shader fallback, proxy
  atlas/descriptor use, and server proxy generation should be deleted or
  temporarily isolated as unreachable legacy with a tracked deletion path.
- Non-server-mediated/direct datasets use source-backed coarse only. Generated
  coarse requires server mediation with a writable/readable Lucida derived
  cache. If no valid source coarse exists outside server mediation, render
  selected detail only and report coarse unavailable; do not generate in browser
  or mutate source data for this implementation.
- Generated levels append after source levels or use unique numeric level
  indices that do not collide. `coarse_level_index` may point to source or
  generated levels, but detail selection remains source-only by default and
  stale detail overrides clamp to source levels. Generated level identity/config
  lives in generated-level metadata, not only in numeric index.
