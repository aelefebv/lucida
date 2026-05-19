---
created: 2026-05-18
modified: 2026-05-18
---

# Clean two-source chunk-tier renderer

Status: Accepted

## Decision

The new coarse/detail renderer path binds and represents detail and coarse as
two explicit chunk tier sources:

- `detail` — the selected source pyramid level.
- `coarse` — the configured coarse level, whether source-backed or generated.

The shader uses one draw path with simultaneous access to both sources. Sampling
order is exactly selected detail, then coarse, then blank. There is no blending,
no separate coarse compositing pass, no field-proxy or well-proxy fallback, and
no implicit fallback to other source detail levels.

The new path must not reuse proxy binding slots, proxy descriptor names, or
proxy shader fallback branches for coarse. Descriptor state, worker protocol
messages, pool keys, atlas routing, wanted sets, debug labels, and tests should
use tier names directly.

The renderer supports independent detail and coarse chunk geometry from the
start. Detail and coarse may have different chunk shapes, slot dimensions,
texture pools, indirection entries, and upload residency state. A source-backed
coarse level with arbitrary chunk shapes is valid immediately; generated coarse
may later use a configured chunk shape without changing shader semantics.

## Why

Reusing proxy bindings would make the new model look cheaper initially, but it
would preserve the wrong abstraction at the exact boundary that needs to become
explicit. Proxy assets were separate fallback objects; coarse is now a chunk tier
selected by metadata and served through the normal chunk path. Carrying proxy
names through WGSL and descriptor layout would make the default flip and proxy
retirement harder to verify.

A separate coarse pass would also encode the wrong semantics. Fallback is
per-sample: render selected detail where present, render coarse where detail is
absent, then leave true misses blank. This matters for both slice and volume
rendering; volume ray marching cannot be faithfully represented as "draw coarse
behind detail" without changing visibility behavior.

Lucida intentionally has two named tier sources rather than a generic N-tier
renderer. ADR 0039 establishes a two-tier product model, and this renderer
decision keeps that model concrete. Generalizing descriptors now would add
indirection before Lucida has a third tier with clear semantics.

The decision follows
[[principles/planning#2-memory-is-the-binding-constraint]] by keeping each tier's
GPU residency visible and budgetable. It follows
[[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]
because tier source identity and residency state stay explicit in planner and
worker state rather than being inferred from legacy proxy state.

## Consequences

- WGSL bindings, descriptor layout, worker protocol, and renderer cold state
  need larger edits than a proxy-slot reuse bridge.
- Descriptor layout lock tests must cover the new detail/coarse tier fields in
  both slice and volume shaders.
- The new path has no proxy compatibility inside the shader or descriptor
  model. Any legacy proxy path remains behind the old-path feature guard until
  default flip, then is deleted or made unreachable.
- Atlas and texture-pool code must key residency by tier and chunk geometry, not
  by dataset alone.
- Upload and eviction feedback must preserve tier identity so coarse and detail
  cannot accidentally evict or satisfy each other's residency requests.
- Tests should assert fallback order, independent chunk geometry, absence of
  proxy names/messages on the new path, and no implicit coarser-detail fallback.

## How this decision should show up in code

- `lucida-web/src/renderer/descriptor/` owns explicit descriptor fields for
  detail and coarse tier sources.
- `lucida-web/src/renderer/slice/` and `lucida-web/src/renderer/volume/` sample
  both tier sources in a single shader path.
- `lucida-web/src/renderer/worker/` and GPU residency state route uploads,
  evictions, and wanted sets by `(dataset/image/member, tier, level, chunk
  geometry)`.
- Tier debug surfaces and telemetry use `detail` and `coarse` names, not proxy
  aliases.

## Related

- [[decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test]]
- [[decisions/0039-chunk-only-coarse-detail-residency]]
- [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- [[principles/planning#2-memory-is-the-binding-constraint]]
- [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]
- PRD #672
- Issue #682
- Issue #689
