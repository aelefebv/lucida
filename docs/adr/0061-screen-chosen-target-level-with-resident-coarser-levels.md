# Screen-chosen target level with resident coarser levels

Status: Accepted. Replaces the former ADRs 0039 (chunk-only coarse/detail residency) and
0041 (two-source chunk-tier renderer). Their standing parts are restated here.

## Context

Fallback rendering once used proxy assets: low-resolution textures generated per tile or
group, with their own catalog, generator, cache, upload messages, atlases, descriptor fields,
and shader branch. Large collections exposed far more proxy candidates than GPU memory could
hold, and the parallel pipeline was hard to budget. The first chunk-only model replaced
proxies with two chunk tiers and fixed detail at source level 0 unless the user chose another
level. Level choice then never looked at the screen, so the wanted set grew with the dataset:
zoomed out over a 216-member collection the planner asked for about 21,000 level-0 chunks per
rebuild, against remote reads that plateau near 57 per second
([ADR 0053](0053-fair-share-source-read-admission.md)). Level 0 drawn on a screen eight times
too small also shows one sample in 64, a decimated picture, and correctness outranks
smoothness ([intention.md](../../intention.md)).

## Decision

Residency has two chunk tiers. The coarse tier holds one bounded floor level per image or
tile, source-backed or generated ([ADR 0040](0040-generated-coarse-as-derived-pyramid-levels.md)),
and is the last resort before blank. The detail tier holds chunks around the viewport from up
to four levels per entity. Both tiers are ordinary chunks. Tier identity is explicit in
requests, wanted sets, upload and eviction feedback, pool keys, and descriptors. CPU budgets
and GPU pools are separate per tier, so one tier cannot evict the other, though an idle tier
lends its unused CPU budget. Residency is decided per tile. A collection group stays a layout
and navigation unit.

The target level is the coarsest level that still places at least one sample under every
device pixel. If the screen shows z device pixels per level-0 sample and level L is r times
coarser than level 0, the target is the largest L with z·r ≤ 1, or level 0 when none
qualifies. r is the real shape ratio along the most-downsampled axis the view resolves: the
two in-plane axes in slice mode, all three in volume mode, with one target per entity.
`lucida-core` computes it in the view query, so the browser, CLI, and Python client agree.
Generated coarse levels are never targets. The target depends on the camera and the level
geometry only. Memory pressure never changes it: under pressure the viewer loses coverage,
never resolution, and says so. The target moves only after the measure crosses a level
boundary by a quarter octave, so a slow zoom does not flap.

The per-dataset level override keeps its saved-view encoding. Absent means follow the screen.
A number pins the target to that level, clamped to the source levels, and pinning level 0
restores the old behavior.

Planning requests detail at the target only. Chunks already resident at coarser levels stay
mapped, so a level change refines instead of dropping to the floor. Eviction inside detail
takes chunks finer than the target first, then the chunks farthest from the view. Prefetch
may request the next level in the direction of the last zoom, inside its existing budget,
unless the level is pinned.

One draw path sees every source. Per sample the renderer takes the finest resident level not
finer than the target, then coarser resident levels, then coarse, then blank. Every sample
comes from exactly one level, with no blending. The volume march scales its step to the
level that answered. Each source carries its own chunk geometry, and a level with a different
chunk shape lands in a different pool. The layer panel, the sparse-detail notice, and the
trace show the target and the displayed level, so the displayed level is never implied.

The bound that justifies this: at the target a chunk of c samples per side covers at least
(c·z·r)² device pixels, and z·r lies between one half and one for a factor-of-two pyramid.
Visible tiles do not overlap, so the visible detail set is at most the viewport area over one
chunk's footprint plus a border term per tile. Dataset size does not appear. The bound
loosens only where even the coarsest source level is undersampled, which the coarse tier
covers. Four levels cost little: a full chain of coarser levels adds about a third of the
target level's bytes in slice mode and a seventh in volume mode.

The proxy path is residue. Planning never emits a proxy request and the server serves proxies
only behind `legacy_proxy_enabled`, default off. `lucida-server/src/proxy/`, the `lucida-proxy`
crate, and the renderer's proxy atlas still exist, and [ADR 0043](0043-superseded-server-surfaces-sunset.md)
decides their deletion. The tier path reuses none of their bindings, fields, or shader branches.

## Rejected alternatives

- Keep proxy assets as the fallback. A second asset class with its own pipeline, budgeted
  apart from chunks, for a job chunks already do.
- Level 0 by default. The wanted set scales with the dataset and the picture is decimated.
  The requirement behind it splits three ways: reaching the finest data is kept (zoom in or
  pin), never lowering the level under memory pressure is kept, and fetching level 0 when the
  screen cannot show it is dropped.
- Raise read throughput, or shed and reorder the wanted set. ADR 0053 found the link is the
  ceiling, and [ADR 0044](0044-bounded-admission-window-for-an-oversubscribed-wanted-set.md)
  showed a chunk arrives at its rank over throughput, so neither fills a 21,000-deep set.
- A third fixed tier. Still chosen without the screen, so it fails at the next zoom step.
- Choose the level from memory pressure. Resolution would depend on free memory, and a
  headless capture would differ from what a person sees.
- One resident level per entity. Every level change drops the view to the coarse floor.
- Unbounded resident levels. Four levels span a factor of eight per axis, and more buys
  nothing a zoom reaches before the next target arrives.
- Sample finer-than-target chunks where the target is missing. That is the decimated picture
  again, and the displayed level would depend on eviction timing.
- Pick the finest level whose samples land at least a pixel apart. It never discards a sample
  but magnifies up to two times. The chosen side bounds decimation below two per axis.
- Reuse proxy binding slots for coarse. Cheaper at first, but it carries the wrong
  abstraction through WGSL and the descriptor and makes proxy removal hard to verify.
- A separate coarse pass drawn behind detail. Fallback is per sample, and a volume ray march
  cannot be expressed as one pass behind another without changing visibility.
- A generic N-tier renderer. No third tier has clear semantics. The detail tier carries a
  bounded array of level sources instead.
- A group as the residency unit, or one level per group. Tiles have their own chunks, and
  siblings share geometry and screen size, so they usually agree. Quantizing per group is a
  follow-up if per-tile levels read as a patchwork.
- Blend between levels. One level per sample keeps "which level am I seeing" answerable.
- A level per sample along a volume ray (deferred), or server-generated intermediate levels
  (out of scope).

## Consequences

Saved views without a pin changed meaning, from level 0 to follow the screen. The remote fill
measurement is still pending; `docs/research/level-chain-harness/README.md` holds the local
results and the command.
