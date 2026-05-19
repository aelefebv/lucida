# Coarse/detail renderer grill notes

Scope: focused `/code` grill for independent coarse/detail GPU residency after the bridge implementation.

Repo source of truth: `/Users/austin/code/lucida/wiki/outputs/2026-05-18-coarse-detail-renderer-grill.md`.

Anchors:
- PRD #672 / temp PRD: `/private/tmp/lucida-coarse-detail-residency-prd.md`
- Slice 02: source-backed coarse/detail rendering path
- Slice 06: separate coarse/detail CPU/GPU buckets and minimap separation
- ADR 0039: chunk-only coarse/detail residency
- ADR 0040: generated coarse as derived pyramid levels

Already settled:
- Two tiers: `coarse` and `detail`.
- Detail defaults to source level 0; lower detail is explicit user choice.
- Shader fallback target is selected detail, then coarse, then blank.
- Coarse/detail must be explicit tier semantics, not proxy semantics.
- Residency may be per field/image; well coherence as residency unit is intentionally relaxed.

Current bridge limitation:
- A member maps to one chunk atlas pool keyed by target/detail chunk dimensions.
- Detail and coarse are only both usable when their chunk shapes match that pool.
- Mismatched source coarse levels require independent tier pool routing and shader/descriptor changes.

Open grill thread:
- Decide how independent coarse/detail GPU residency should be represented.

Clarification:
- Different coarse/detail chunk sizes are expected and should be supported.
- That requires separate tier atlas textures/indirection/pool routing; one pool cannot safely hold both.
- Shader sampling remains position-based: map entity-local position into each tier's level dimensions, divide by that tier's chunk dimensions, read that tier's indirection, then sample that tier's atlas slot.
- Slice mode also needs explicit full-res-Z to level-Z mapping per tier so detail and coarse choose the correct source Z chunk independently.

Recommendation:
- Use one draw with simultaneous detail and coarse chunk bindings, not separate coarse/detail render passes.
- Introduce an explicit tier-source abstraction in worker state/descriptors: each rendered member can have a `detail` source and a `coarse` source, each with its own pool key, texture, indirection, slot dims, LOD metadata, and budget.
- Start with exactly two named tier sources rather than a generic N-tier runtime abstraction; keep the data shape regular enough that a later third tier would be additive.

Decision:
- Accepted: one render pass/draw path with simultaneous detail and coarse chunk sources.
- Accepted: GPU residency uses protected coarse/detail buckets with no cross-tier eviction. Fetch/decode/upload capacity may be elastic when one tier has no work.
- Accepted: use exactly two named tier sources rather than a generic N-tier runtime abstraction.
- Accepted: add clean new chunk-tier shader/descriptor/bind-group bindings rather than reusing proxy binding slots.
- Accepted: clear proxy semantics from the new renderer path now; defer full proxy stack deletion until generated coarse/default flip.
- Accepted: support arbitrary source coarse chunk shapes immediately; generated coarse chunk shape normalization is not a renderer prerequisite.
- Accepted: main renderer requests visible coarse first; near/background coarse fill is bounded, lower priority, and cancellable.
- Accepted: minimap and main view share CPU coarse bytes but keep separate GPU residency and upload accounting.
- Accepted: CPU decoded-byte cache uses protected minimums with elastic surplus borrowing; GPU residency remains hard protected.
