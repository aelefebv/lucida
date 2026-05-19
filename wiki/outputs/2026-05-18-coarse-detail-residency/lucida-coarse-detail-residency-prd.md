# PRD: Chunk-only coarse/detail residency

Source issue: https://github.com/aelefebv/lucida/issues/561

## Problem Statement

Lucida currently uses proxy assets and radius-dependent promotion modes to keep large images and plates visually coherent while detail chunks arrive. That makes fallback behavior depend on a separate proxy catalog, proxy generation path, well-level promotion rules, and renderer-side proxy sampling. The result is hard to reason about, hard to budget, and mismatched with the way single-image datasets and plate fields are actually stored: chunks are the durable unit, but fallback is modeled as a different asset class.

Users need two things at once. They need a bounded coarse representation that gives spatial context for the whole visible dataset, and they need the highest available source resolution by default when they inspect detail. Microscopists should not be silently moved to a lower-resolution detail level because the system is under pressure. If high-resolution chunks are too large to show densely, the viewer should make that sparse-detail state visible and offer an explicit lower-detail control.

The current proxy path also makes interaction scheduling too sticky. If a user scrubs time or Z, stale fallback work can keep running for the old view while the new view waits. The fallback system needs priority lanes, preemption, cancellation, readiness signaling, and cache separation that are expressed in the same chunk pipeline used by normal rendering.

## Solution

Replace the proxy-based radius fallback model with a canonical two-tier chunk residency model.

`coarse` is a bounded per-image or per-field representation used for context and fallback. If an existing source pyramid level fits the coarse size and byte budget, that source level is marked as the coarse level. If no source level fits, the server creates an append-only derived coarse level in a server-managed derived cache. Coarse generation is lazy, demand-driven, proactive, cancellable, and reusable across dataset reopens when the source content identity and generation config are unchanged.

`detail` is a selected source pyramid level around the active viewport radius. Detail defaults to the highest-resolution source level, which is numeric LOD 0. Users must explicitly choose a lower detail level if they want less detail or better coverage. Generated coarse levels are not presented as normal detail choices by default.

Planning emits tier-labeled chunk requests using WASM-produced visibility regions and screen-pixel radius policy. CPU cache, upload, worker protocol, GPU residency, descriptors, and shaders carry the tier explicitly. Coarse and detail have separate residency buckets so one tier cannot evict the other. Fetch, decode, and upload capacity may be shared elastically when one tier has no work.

The shader fallback chain becomes selected detail, then coarse, then blank. Proxy catalogs, proxy requests, proxy stores, proxy atlases, proxy descriptors, and proxy fallback semantics are deprecated and deleted after a bridge period.

## User Stories

1. As a microscopist, I want the viewer to default to the highest-resolution source level, so that inspection starts from the scientific detail I expect.
2. As a microscopist, I want to explicitly choose a lower detail level only when I decide to, so that memory pressure does not silently reduce the resolution I am evaluating.
3. As a microscopist, I want large high-resolution chunks to appear when they are available while coarse context remains visible elsewhere, so that sparse detail does not leave me spatially lost.
4. As a microscopist, I want an info or log message when high-resolution coverage is sparse because chunks are huge or budgets are tight, so that I understand why only a few detail chunks are appearing.
5. As a microscopist, I want the sparse-detail message to offer the lower-detail control, so that the next action is obvious without hiding the default highest-resolution behavior.
6. As a plate viewer, I want plates and single-image datasets to use the same chunk tier model, so that fallback behavior is consistent across dataset shapes.
7. As a plate viewer, I want each field to have its own coarse and detail chunk residency, so that one field does not force unrelated fields to wait for a shared generated asset.
8. As a plate viewer, I want wells to keep their layout and grouping behavior, so that plate navigation remains organized even when residency is field-based.
9. As a user opening a huge dataset, I want the dataset to open before generated coarse chunks are complete, so that import/open latency is not blocked on fallback generation.
10. As a user opening a huge dataset, I want already-generated coarse chunks to be reused on reopen, so that repeated sessions do not redo unchanged work.
11. As a user with source data on local server paths, I want generated coarse data to live beside the server store rather than inside my source Zarr, so that Lucida never mutates the original dataset.
12. As a user scrubbing time, I want coarse generation for stale timepoints to be canceled or preempted, so that the current timepoint starts generating promptly.
13. As a user scrubbing Z, I want the active Z plane to outrank stale nearby work, so that interaction feels responsive while I move through the stack.
14. As a user toggling channels, I want newly visible channels to receive generation and fetch priority, so that channel changes do not wait behind background fill for hidden channels.
15. As a user panning or zooming, I want detail requests near the viewport to outrank far detail requests, so that the area I am looking at sharpens first.
16. As a user panning or zooming, I want coarse context to remain resident while detail churns, so that movement does not collapse into blank regions.
17. As a user looking at the minimap, I want the minimap to use the explicit coarse level, so that it does not guess from the last pyramid level.
18. As a user looking at the minimap, I want minimap GPU/upload residency to stay separate from the main view, so that minimap rendering does not steal main-view GPU slots.
19. As a collaborator joining a session, I want source and already-cached generated levels to appear in the initial dataset-opened state, so that I do not need a separate proxy catalog warm-up path.
20. As a collaborator joining during generation, I want readiness updates to be broadcast when generated chunks become available, so that my client can request the normal chunk path at the right time.
21. As a user saving a view, I want explicit detail-level overrides to be preserved and stale overrides to be clamped, so that saved views remain useful after dataset metadata changes.
22. As a user saving a default view, I want the default highest-resolution detail setting to serialize as absent or null, so that saved views do not freeze an unnecessary override.
23. As an operator, I want background coarse fill to be bounded and optionally disabled, so that server resources are predictable.
24. As an operator, I want telemetry for desired versus resident coarse and detail chunks and bytes, so that memory pressure and generation backlog are diagnosable.
25. As an operator, I want pending generated chunks to return a non-error pending status, so that transient generation state is not confused with missing data.
26. As a renderer developer, I want coarse and detail to be first-class chunk tiers, so that planning, CPU cache, upload, worker protocol, GPU residency, and shaders share one vocabulary.
27. As a renderer developer, I want coarse and detail to have separate CPU and GPU buckets, so that coarse fallback cannot be evicted by detail churn and detail cannot be evicted by background coarse fill.
28. As a renderer developer, I want fetch, decode, and upload capacity to be elastic across tiers, so that unused capacity is not stranded.
29. As a renderer developer, I want tier labels on wanted-set and upload messages, so that delivery and GPU routing do not infer meaning from level number alone.
30. As a renderer developer, I want generated coarse levels to use normal chunk keys and chunk serving after resolution, so that the binary transport stays simple.
31. As a server developer, I want a single server-wide coarse generation service, so that dedupe, cancellation, fairness, readiness, and cache identity are coordinated globally.
32. As a server developer, I want coarse jobs deduped by source identity, generation config, image, derived level, and chunk key, so that multiple viewers do not generate the same chunk twice.
33. As a server developer, I want atomic cache writes and readiness publish, so that clients never observe a generated chunk before the resolver can serve it.
34. As a maintainer, I want the proxy path removed after the bridge period, so that there is one fallback model instead of two partially overlapping systems.

## Implementation Decisions

- The issue's original three-tier model is replaced with a two-tier model: `coarse` and `detail`. `medium` is deferred until evidence shows coarse/detail is insufficient.
- `overview` should be treated as a migration alias where needed, but new concepts and UI should use `coarse`.
- Numeric LOD convention remains unchanged: source level 0 is highest resolution.
- Detail defaults to source level 0. A missing or null detail override means "highest-resolution source level"; a numeric override means an explicit user choice.
- Detail overrides are per-dataset viewport/display state. They are suitable for presence and saved views, but they are not document content.
- Saved-view handling must strip or restore the default null detail override and clamp stale numeric overrides to selectable source detail levels.
- Detail-level UI should label choices by meaning and resolution rather than raw LOD numbers.
- Source pyramid levels are selectable detail levels. Generated coarse levels are tier metadata and are not normal detail choices by default.
- `MultiscaleInfo` owns the coarse pointer and generated-level provenance/config metadata. Image metadata exposes the coarse level. `LevelGeometry` stays geometry-only.
- If an existing source level satisfies coarse constraints, the coarse pointer references that source level. If no source level satisfies the constraints, the server appends a derived level after the source levels.
- Derived levels are append-only. Level indices must not be reordered, replaced, or reused for a different generation config.
- If generation config changes, the server publishes a new derived-level identity or metadata snapshot rather than mutating the meaning of an old derived level.
- Coarse generation is per image or field, not per well. This relaxes [[principles/planning#3-wells-are-coherent-visual-units]] because chunk residency should follow image storage and scheduling units; wells remain coherent layout/grouping units rather than generated fallback assets.
- Coarse output is bounded per image/channel by configured long-axis and byte limits. The desired shape is one chunk per image/channel when possible, otherwise a small bounded grid.
- Dataset open/import does not wait for generated coarse. Generation runs lazily in the background after open and publishes readiness incrementally.
- Generated coarse lives in a server-managed derived-level cache associated with the Lucida store, not in the source dataset and not in the old proxy cache.
- Lucida must never mutate user/source Zarr data, including server-local file path datasets.
- Derived cache identity is keyed by source content identity, generation config, image identity, derived level identity, and chunk key.
- Chunk resolution becomes source-aware: source levels resolve against source storage, while generated levels resolve against the derived cache.
- Generated coarse uses normal chunk serving once materialized. There is no special generated-coarse binary transport.
- Server publication is atomic from the client's perspective: resolver binding, retained dataset-open state, client-visible metadata overlay, and broadcast readiness are updated only after the chunk or level can be served.
- Initial dataset-opened state includes source levels plus any already-cached generated levels. Later generated levels arrive as server-authored metadata/readiness deltas.
- Generated-level availability bumps an asset or availability epoch, not a user document-content epoch.
- Planning consumes WASM-produced expanded bounds and visibility regions rather than re-deriving viewport geometry in JS. Chosen to honor [[principles/planning#5-wasm-owns-truth-planning-consumes-a-snapshot]].
- Planning remains a pure function over a snapshot, explicit carry-forward state, and config. Chosen to honor [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]].
- Radius policy is expressed in screen pixels, but the planner works from snapshot fields supplied by WASM and emits tier-labeled chunk requests.
- Planning emits coarse requests at the image's coarse level and detail requests at the selected detail level.
- Coarse scheduling is chunk-level for all dataset types, including single-image datasets.
- Priority lanes cover current visible work, near-future/predicted work, minimap/coarse context, and background fill. They must be reprioritized by pan/zoom, temporal scrubbing, Z scrubbing, and channel toggles. Chosen to honor [[principles/planning#6-anticipate-the-users-likely-next-gesture]] within bounded memory.
- The server owns a server-wide coarse generation service rather than per-dataset generators. The service owns global concurrency, priority queues, cancellation tokens, viewer-interest registry, readiness state, and generated-level cache identity.
- Viewer-interest hints are advisory, unsequenced client messages. They include dataset identity, current T/Z, visible channels, viewport or desired-soon coarse regions, interaction mode, and client/dataset interest generation.
- Multi-client scheduling uses fairness plus recency: visible work outranks background fill, newer interest supersedes older interest for the same client/dataset, conflicts round-robin within a lane, and idle/disconnected hints expire.
- Stale generation must be cancelable or preemptible. The externally visible cancellation unit is one generated coarse chunk; large generated chunks should be internally tile-stepped so cancellation checks are frequent.
- Completed generated chunks are retained. Partial writes are discarded.
- Chunk fetch requests mean "send bytes if materialized now." The server must not hold the request open until generation finishes.
- Pending generated chunks return an explicit non-error pending status. Real misses and failures return explicit unavailable or error statuses.
- Clients clear in-flight fetch state on pending without recording a transient or permanent failure. Readiness updates cause clients to re-request through the normal chunk path.
- Coarse and detail have separate CPU cache buckets and separate GPU residency buckets. This is chosen to honor [[principles/planning#2-memory-is-the-binding-constraint]] by making budgets explicit and preventing one tier from evicting the other.
- Tier buckets may contain multiple internal stores, atlases, or pools when dimensions, channel grouping, or device limits require it.
- The first PRD keeps memory buckets fixed and non-borrowable. Borrowing between memory buckets is deferred.
- Fetch, decode, and upload capacity is elastic: reserve capacity per tier when it has work, but allow unused capacity to shift to the other tier.
- Detail LOD is not automatically lowered under memory pressure. The system adapts by spatial coverage, scheduling, and eviction order, then reports sparse-detail state to the user.
- Telemetry must expose desired versus resident detail/coarse chunks and bytes, budget pressure, generated-coarse pending/ready state, and whether sparse detail appears budget-driven.
- Worker cold state carries explicit detail and coarse levels. Wanted-set and upload messages carry `detail` or `coarse` tier labels.
- Worker routing maps each rendered member to independent detail and coarse pool keys rather than overloading a single LOD or proxy slot concept.
- Descriptors and shaders expose detail and coarse chunk sources. The fallback chain is selected detail, then coarse, then blank.
- The old proxy binding space may be reused after proxies are retired, but the semantics must be coarse chunk texture/indirection, not proxy asset semantics.
- Main renderer and minimap may share coarse CPU chunks, but they keep separate GPU/upload residency. The minimap uses explicit coarse metadata rather than assuming the last level is the minimap level.
- Proxy migration happens in three phases: bridge coarse/detail behind internal config while proxy still works; make chunk-only coarse/detail the default and stop emitting proxy catalogs/requests/assets; delete proxy server, protocol, web store, worker, shader, debug, and planning-mode surfaces.
- The proxy path has no long-term wire-compatibility promise. Compatibility exists only as a temporary bridge to reach parity.
- Existing proxy and well-residency ADRs/docs should be superseded by new ADRs for chunk-only coarse/detail residency and generated coarse as store-owned derived pyramid levels.
- The first implementation supports server-mediated datasets, including server-local file path datasets.
- Browser-side direct fetch and protocol-local fetch paths remain future scope.

## Testing Decisions

- Tests should assert externally visible behavior at subsystem boundaries, not private helper sequencing. Good tests should be resilient to internal refactors that preserve the contract.
- Planning tests should cover tier-labeled coarse/detail emission, default detail level selection, explicit detail overrides, per-field plate scheduling, single-image scheduling, priority lanes, scrubbing reprioritization, and the absence of proxy requests in the new path.
- Planning snapshot tests should verify that expanded bounds and visibility inputs are consumed from WASM-facing snapshot data rather than recomputed in JS.
- Metadata and wire-format tests should cover additive generated-level metadata, coarse pointers, detail override defaults, saved-view backward compatibility, saved-view clamping, and old settings JSON without detail overrides.
- Server/store tests should cover derived cache identity, source-versus-derived chunk resolution, atomic publish ordering, persisted reuse across reopen, pending versus unavailable chunk statuses, and readiness broadcasts to multiple open clients.
- Coarse generation service tests should use fake source data and fake generation workers to cover dedupe, priority lanes, cancellation, tile-step cancellation checks, fairness across clients, hint expiration, and background-fill disablement.
- Chunk fetch/client tests should verify that pending generated chunks clear in-flight state without entering failure tracking, and that readiness updates trigger normal re-request behavior.
- CPU cache tests should cover separate coarse/detail budgets, no cross-tier eviction, elastic fetch/decode/upload capacity, tier-aware delivery ordering, and telemetry counters for desired/resident bytes.
- Upload and worker-protocol tests should cover tier labels on delivery messages and wanted-set messages.
- GPU residency tests should cover independent detail/coarse pool keys, descriptor layout agreement, shader fallback order, minimap separation, and eviction feedback that preserves tier meaning.
- Renderer lock tests should continue to parse shader descriptor layouts where applicable so TypeScript descriptor constants and WGSL structs cannot drift.
- UI/state tests should cover the detail-level control, default highest-resolution behavior, sparse-detail notice behavior, and saved-view persistence of explicit overrides.
- Proxy migration tests should assert that the default new path does not emit asset catalogs, proxy asset requests, proxy uploads, or proxy planning modes.
- End-to-end tests should open a server-mediated dataset, observe source plus cached generated levels in dataset-open state, receive generated readiness deltas, request generated chunks through the normal chunk path, and reopen to confirm reuse.

## Out of Scope

- A third `medium` residency tier.
- Automatic lowering of detail LOD under memory pressure.
- Borrowing between coarse and detail memory buckets.
- Treating generated coarse levels as normal user-selectable detail levels by default.
- Aggregated well-level generated assets.
- Mutating source Zarr stores or local source files.
- Long-term proxy wire compatibility.
- Browser-side direct fetch and protocol-local fetch support.
- A new binary transport specifically for generated coarse data.
- Full redesign of minimap rendering beyond explicit coarse-level use and separate GPU/upload residency.
- Final tuning of exact byte budgets, long-axis limits, and priority constants beyond adding configurable seams and telemetry.

## Further Notes

- This PRD intentionally pivots issue #561 from a three-tier overview/region/detail model to a two-tier coarse/detail model.
- The design keeps the useful part of radius-dependent fallback, which is bounded coarse context plus prioritized detail, while deleting proxy-specific asset classes and well proxy semantics.
- The highest-resolution default is a product requirement, not an optimization detail.
- Two ADRs should be written after the PRD issue is filed: one for chunk-only coarse/detail residency replacing proxy fallback and relaxing well-as-residency-unit behavior, and one for generated coarse as store-owned derived pyramid levels with metadata/readiness deltas.
- Documentation updates should retire proxy-generation flow docs and update planning, CPU cache, upload pipeline, worker protocol, GPU residency, minimap, and chunk lifecycle wiki pages.
