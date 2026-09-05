---
type: Decision
title: "Screen-chosen target level with resident coarser levels"
description: "Each image-bearing entity's target level is chosen from the screen, the detail tier keeps up to four levels resident per entity, and the renderer samples the finest resident level not finer than the target before falling to coarser ones and then to the coarse tier."
tags: [lucida, decision]
source_path: wiki/decisions/0061-screen-chosen-target-level-with-resident-coarser-levels.md
created: 2026-09-04
modified: 2026-09-04
---

# Screen-chosen target level with resident coarser levels

Status: Accepted (spec #989). Measured by the end-to-end ticket of that spec (#1003);
see the last section.

Supersedes [Chunk-only coarse/detail residency](0039-chunk-only-coarse-detail-residency.md)
on the level-0 default, and
[Clean two-source chunk-tier renderer](0041-clean-two-source-chunk-tier-renderer.md) on
the number of detail sources and the sampling order. Retires the multi-level residency
entry from [Deferred](deferred.md). Everything else in both ADRs stands, and the coarse
tier of [Generated coarse as derived pyramid levels](0040-generated-coarse-as-derived-pyramid-levels.md)
is unchanged.

## Decision

**The target level follows the screen.** Each image-bearing entity has a target level:
the coarsest level that still places at least one sample under every device pixel. Let
the screen show *z* device pixels per level-0 sample, and let level *L* be *r* times
coarser than level 0. Level *L* then lands its samples *z·r* device pixels apart, and the
target is the largest *L* with *z·r* at most 1. If level 0 already spreads its samples
more than one pixel apart, the target is 0. If even the coarsest level packs more than
one sample into a pixel, the target is the coarsest level. Zooming in moves the target
toward level 0, and zooming out moves it toward the coarsest source level.

The rule reads the real shape ratio between level 0 and each level rather than assuming
a factor of two per level, and it counts device pixels. In slice mode it compares the two
in-plane axes, so a level that downsamples only the third axis is not chosen early. In
volume mode it uses the pixels-per-sample measure the camera already takes at the ray
hit, which uses the most conservative axis, and it picks one target per entity. The rule
lives in `lucida-core`, where the view query already computes it per entity from
projected size. That value becomes authoritative for the browser, the CLI, and the Python
client alike, which is
[planning principle 5](../principles/planning.md#5-the-view-math-has-one-home-and-planning-isnt-it)
and [surface parity](../principles/surface-parity.md) at once.

**The target depends on the camera and the level geometry, and on nothing else.** Memory
pressure never changes it. Under pressure the system loses coverage, never resolution,
and it says so.

**Hysteresis.** The target changes only after the measure crosses a level boundary by a
fixed fraction of an octave, so a slow zoom does not flap between two levels. The
previous target is carry-forward state passed in the open, per
[planning principle 4](../principles/planning.md#4-planning-is-a-pure-function-of-a-snapshot),
and the target is part of what the view-query delta in `lucida-core` tracks, so a level
change arrives as an observed delta and not as a full rebuild.

**The level pin replaces the override.** The per-dataset override keeps its saved-view
encoding and changes meaning. Absent means follow the screen. A number pins the target
to that level, so level 0 becomes a selectable choice instead of the meaning of absent,
and pinning to level 0 restores the previous behavior exactly. The core clamps a stale
pin to the selectable source levels, as today. A saved view with a pin keeps meaning the
same level, and a saved view without one now follows the screen.

**Residency.** The detail tier holds chunks from more than one level per entity.
Planning emits detail requests at the target level only, and chunks already resident at
coarser levels stay mapped, which is
[planning principle 1](../principles/planning.md#1-the-smoother-render-wins-over-the-cheaper-fetch):
the view refines across a level change rather than flickering. The bound is four resident
levels per entity, with the coarse source outside the count. A level finer than the
target counts against the bound until eviction reaches it, and eviction inside the
detail tier takes chunks finer than the target first, then the chunks farthest from the
view. The prefetch lane may request the next level in the direction of the last zoom
change, inside its existing budget
([planning principle 6](../principles/planning.md#6-fetch-a-step-ahead-of-the-users-likely-next-move)).
The coarse tier is unchanged: one bounded floor level per image or tile, and still the
last resort before blank.

**Sampling order.** The renderer samples the finest resident level that is not finer
than the target, then coarser resident levels in order, then the coarse tier, then
blank. Every sample comes from exactly one level, and there is no blending between
levels. The volume ray march scales its step with the spacing of the level it samples.
Pools stay keyed by chunk geometry, so a level with a different chunk shape lands in a
different pool and the per-entity descriptor says which.

**The displayed level is shown, never implied.** The layer panel shows the target level,
the displayed level where it differs, and the downsampling method from the multiscale
metadata when present. The sparse-detail notice names both levels rather than only
saying that detail is sparse. The per-tick aggregate and the trace carry the same two
numbers, so a stall can be attributed to a level change.

## Why the two-tier model did not hold

PRD #672 chose two fixed tiers deliberately and deferred more levels "until evidence
shows coarse/detail is insufficient". Issues #900 and #901 are that evidence.

Under ADR 0039 the detail tier is level 0 unless the user picks a coarser level by hand,
and level selection never looks at the screen, so the wanted set grows with the dataset
and not with the screen. Zoomed out over a 216-member collection, the planner asked for
about 21,000 level-0 chunks per rebuild (#900).
[ADR 0044](0044-bounded-admission-window-for-an-oversubscribed-wanted-set.md) bounded
the queue's bookkeeping and said plainly that no chunk arrives sooner. #901 then measured
the other end: its concurrency sweep found read throughput plateauing at 16 concurrent
reads, near 57 reads per second, and
[ADR 0053](0053-fair-share-source-read-admission.md) records that past the plateau the
link is the ceiling. With 21,000 chunks against 57 per second a zoomed-out view takes
minutes to fill, and nothing left on the server side changes that. The remaining lever
is demand, and a target chosen from the screen is the only way the number stops growing
with the collection.

The correctness argument runs the same way. Level 0 sampled nearest on a screen eight
times too small shows one sample in 64 and discards the rest. That is a decimated
picture, not a faithful one, and [intention.md](../../intention.md) puts correctness
above smoothness. A downsampled level is the faithful picture at that scale, and
showing the displayed level keeps it honest.

ADR 0039 called the level-0 default "a product requirement". That requirement fused
three claims. Inspection must reach the finest source data: kept, because
zooming in reaches level 0 whenever the screen can show it, and a pin reaches it
regardless. Memory pressure must never lower the level: kept verbatim. Level 0 must be
fetched even when the screen cannot show it: dropped, because that was never inspection.

Holding coarser levels is cheap. Each coarser level is a quarter of the previous one in
two dimensions and an eighth in three, so a full chain past the target adds about a third
of the target level's bytes in slice mode and about a seventh in volume mode.

## The wanted-set bound

At the target level a chunk of *c* samples per side covers at least *(c·z·r)²* device
pixels, and for a factor-of-two pyramid *z·r* lies between one half and one. So the
visible detail wanted set for one entity, per displayed plane and channel, is at most
the entity's on-screen area divided by the footprint of one target-level chunk, plus the
partly covered chunks along its border. Tiles of a collection do not overlap on screen,
so the sum over visible tiles is bounded by the viewport area over the same footprint
plus a border term per visible tile. The bound loosens only where even the coarsest
source level is undersampled, where the count is capped by that level's own chunk count
instead; that regime is what the coarse tier exists for. In volume mode the same argument
runs on a chunk's three-dimensional footprint against the part of the volume the view
frustum cuts, and is weaker by the depth of that cut in chunks. Nothing in the bound
mentions the size of the dataset, which is the property the two-tier model lacked.

## Considered options

**Raise read throughput further.** Rejected by measurement. ADR 0053 found the plateau
at 16 concurrent reads with the link as the ceiling, and more streams slowed every read.

**Shed or reprioritize the wanted set.** Rejected by arithmetic. ADR 0044 showed that a
chunk arrives at its rank divided by throughput. Reordering changes which chunk waits,
and nothing arrives sooner while the set is 21,000 deep.

**A third fixed tier.** The middle tier PRD #672 sketched. Rejected because a fixed tier
is still chosen without looking at the screen: it fails at the next zoom step out, and it
adds a tier's worth of vocabulary for one more stop. A screen-chosen level subsumes it.

**Choose the level from memory pressure.** Rejected. A picture whose resolution depends
on the machine's free memory is one a user or agent cannot trust, and a headless capture
would differ from what a person sees. Pressure changes coverage, and the viewer reports
the coverage it lost.

**One resident level per entity, with the coarse floor as the only bridge.** The
cheapest residency model. Rejected because every level change drops the view to the
coarse floor until the new level arrives, on every zoom. The April renderer (#383)
solved exactly this with a fallback chain across resident levels, and PRD #672 discarded
the chain along with the proxy-asset path it was tangled with. This decision restores that
shape on top of the tier vocabulary that #672 introduced.

**Unbounded resident levels.** Rejected by
[planning principle 2](../principles/planning.md#2-stay-within-memory-nothing-is-allowed-past-it).
Four levels span a factor of eight per axis between the finest and the coarsest
resident, and a full chain past the target costs a third again in bytes. More buys
nothing that a zoom can reach before the next target arrives.

**Sample finer-than-target chunks where the target is missing.** Rejected. A finer level
shown zoomed out is the decimated picture this decision removes, and mapping it would
keep the most expensive residents alive and make the displayed level depend on eviction
timing. Zooming out is also the cheap direction: one target-level chunk replaces four
finer ones, and prefetch may fetch the next coarser level ahead of the crossing. The
spec's promise that a level change never drops the view to the coarse floor therefore
holds strictly on zoom in, where the coarser residents are already mapped, and through
prefetch on zoom out.

**The other side of the pixel boundary.** The rule could pick the finest level whose
samples are at least one pixel apart, which never discards a sample but magnifies by up
to two. Rejected in favor of the coarsest level that still fills every pixel, which is
what the core computes today and what a display at its own density asks for. It bounds
decimation to under a factor of two per axis, against the unbounded decimation it
replaces, and hysteresis makes the side a constant rather than a flicker. Spec #989
words the inequality the other way, as "z times r at least 1", but that reading returns
the coarsest level whenever any level qualifies. The spec's own boundary clauses, that an
oversampled level 0 gives 0 and an undersampled coarsest level gives the coarsest, hold
only for the reading recorded here.

**Blend between levels.** Out of scope. A sample from exactly one level keeps "which
level am I looking at" answerable, and a second lookup per ray step is not worth a softer
transition.

**A level per sample along a volume ray.** Deferred. The first version picks one target
per entity in volume mode.

**A level per group in a collection.**
[Planning principle 3](../principles/planning.md#3-a-group-reads-as-one-thing-so-it-should-render-as-one-thing)
asks siblings to agree, and this decision chooses per entity. Sibling tiles share
geometry and near-equal screen size, so they usually agree, and hysteresis widens the
agreement. Quantizing per group is a follow-up if per-tile levels read as a patchwork.

**Generate missing intermediate levels on the server.** Out of scope. A pyramid with
only a fine level and a tiny coarse level renders from whichever level the rule picks.

## Why the deferred entry goes

The deferred entry sketched this decision: several levels resident per entity, eviction
that prefers finer levels, and a buffer of levels past the target. It was deferred on two
grounds. First, that no evidence showed zoom transitions felt jarring, because the
proxy-asset fallback chain bridged the gap. ADR 0039 retired that chain and
[ADR 0043](0043-superseded-server-surfaces-sunset.md) deleted the path behind it, so the
premise is gone. Second, that the single-level model was naturally bounded. #900 showed
the opposite: a single level chosen without looking at the screen is bounded by the
dataset, not the viewport. The decision is now taken, so this ADR removes the entry
rather than leaving it to describe a choice that no longer exists.

## Consequences

- Saved views without a pin change meaning: they followed level 0 and now follow the
  screen. Pinned saved views are unchanged.
- The per-dataset level control gains level 0 as an explicit choice, and its absent
  state stops being labeled as the highest resolution, because it no longer is one.
- A pyramid whose levels differ in chunk shape spreads one entity across pools, and the
  descriptor names the pool per level source.
- The trace and the per-tick aggregate carry the target and the displayed level per
  entity, and the sparse-detail notice reports the displayed level against the target.

## Measured, before and after

Taken on 2026-09-04 by #1003, every run at device pixel ratio 2 over a 1440×900
viewport (2880×1800 device pixels), driven by `lucida trace`. The check is
`extras/verify_level_chain.py`, and the collection measurement is
`docs/research/level-chain-harness/`, whose README carries the full table and the
conditions.

**The level a generated fixture reports.** A 64×512×512 level-index pyramid, four
levels halving every axis in 32³ chunks, every sample at level *L* equal to *L*, opened
four times with the camera in the middle of the zoom band each level owns. In every run
the rule applied to the shapes on disk, the target `lucida-core` computed for the
camera, the target on the trace's last planning pass, and the gray of the settled frame
named the same level, and the chunks planned at that level sat inside the bound above.

| run | device px per level-0 sample | level, all four ways | planned at target | bound | settled |
| --- | --- | --- | --- | --- | --- |
| slice, zoomed in | 0.707 | 0 | 256 | 289 | 0.6 s |
| slice, zoomed out | 0.177 | 2 | 16 | 25 | 0.6 s |
| volume, zoomed in | 0.354 | 1 | 64 | 81 | 0.6 s |
| volume, zoomed out | 0.177 | 2 | 16 | 25 | 0.6 s |

**The 216-member remote collection.** Its geometry, read from the object store: 216
groups on a 24×9 grid holding 21,371 images, each with a level 0 of 256×256 per plane in
one chunk per 16 timepoints spanning both channels and all three planes (a 5.4 MB
object), and a level 1 of 32×32 in one chunk per 64 timepoints (334 kB), a factor of 8.
Zoomed out in that viewport a tile is about 20 device pixels wide, 0.077 pixels per
level-0 sample, and level 1 lands at 0.61, so the target is level 1 and the view is in
the regime the bound names: even the coarsest level is undersampled, and the count is
capped by the tile count. One chunk per tile per level means the visible detail wanted
set per rebuild stays at the 21,000 of ADR 0044 either way. What the decision changes on
this collection is the bytes: 393 kB per tile, timepoint, and channel at level 0 against
6 kB at level 1.

The remote run itself did not happen on the day. The operator's application default
credentials had expired and only an interactive login renews them, so the link speed on
the day, and the remote fill time, are still to be taken; the harness README holds the
one command. The numbers below come from a local twin with the same per-tile geometry,
21,371 tiles of 3×256×256 with a 3×32×32 level 1, served from local disk, where the
link was not the limit (the server read level-0 objects at about 480 per second).

**Before and after on the twin,** two rounds alternating, a fresh server and browser per
run, the page's run capped at 60 s:

| | level 0 pinned (before) | screen-chosen (after) |
| --- | --- | --- |
| target level | 0 | 1 |
| detail requests per rebuild | 21,371 | 21,371 |
| detail tiles resident at 60 s | 1,365 of 21,371 | 21,371 of 21,371 |
| resident bytes, and when they stopped growing | 603 MB at 29 to 44 s | 198 MB at 13.1 to 13.4 s |
| objects the server read in 60 s | 21,682 and 37,692 (8 to 15 GB) | 21,383 (139 MB) |
| queue depth at 60 s | 3,180 and 20,319 | 0 |
| the frame | a central disc of filled tiles, the rest at the floor or blank | every tile filled |

Pinned to level 0 the page can never hold the set: 1,365 tiles is the 512 MiB detail
budget, so residency plateaus there while the queue stays thousands deep and the server
reads the collection over again, 6% of the tiles on screen for 8 to 15 GB read. That is
the memory half of the case ADR 0044 made from throughput. Following the screen, the
whole detail tier is resident inside 13 s off 139 MB, and the frame shows every tile.

Neither run reaches quiescence, for different reasons. Before, the detail tier cannot
complete. After, it does, and the only shortfall is the coarse floor, which the 64 MiB
coarse budget caps at 10,922 of 21,371 tiles on this geometry; that is unchanged by this
decision, holds for the pinned run too, and is filed as #1041. The measurement also
found that a resident slot costs the level's declared chunk shape rather than the chunk's
extent in the level (#1042), and that a run can never be observed settling past 60 s
(#1043).
