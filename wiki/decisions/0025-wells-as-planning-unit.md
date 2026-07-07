---
type: Decision
title: "Groups Are the Planning Unit in Collections"
description: "On collections, planning assigns one promotion mode per group, never per tile."
tags: [lucida, decision]
source_path: wiki/decisions/0025-wells-as-planning-unit.md
created: 2026-05-14
modified: 2026-07-06
---

# Groups Are the Planning Unit in Collections

(The filename keeps its original ADR anchor; the subject is the group as the planning unit.)

Status: Superseded for chunk residency/fallback by
[Chunk-only coarse/detail residency](0039-chunk-only-coarse-detail-residency.md). Groups remain layout and
grouping concepts, but the newer coarse/detail path may schedule residency per
tile/image.

## Decision

On collection datasets, planning treats the **group** as the unit of decision. All tiles belonging to one group agree on a single promotion mode (`group-as-proxy`, `tiles-with-proxy-fallback`, or `tiles-with-detail`); they share the same target LOD; they fetch and render together. Per-tile divergence within a group is not permitted — tiles cannot be in different modes from their siblings even when their individual projected sizes would warrant it.

A group in `group-as-proxy` mode does not enumerate detail chunks for any of its tiles, regardless of any individual tile's visibility, importance, or projected size.

This ADR is a *ratification* — the rule has existed in the code (in `groupMembers` and `assignModes`) and in the wiki article ([Planning Domain](../systems/subsystems/planning-domain.md) under "Invariants") since the three-tier promotion landed. It is captured here so future contributors do not relax it.

Cited in PRD #545.

## Why

A group is a perceptual unit. Users read "group B7" — they do not read "tile 4 of group B7 separately from tile 5 of group B7." A system that gives different tiles within a group different representations creates visible patchwork that reads as a rendering defect, not as informative variation. The user cannot tell whether the patchwork reflects the data, the camera position, or a bug; the most charitable interpretation is "something is broken."

This decision honors [Principles — Planning Domain](../principles/planning.md#3-groups-are-coherent-visual-units). The principle is the abstract claim ("groups are coherent visual units"); this ADR is the concrete consequence in planning's structure (mode is assigned per group; the group's projected diagonal — not any individual tile's — is the input to mode selection).

## Tradeoffs

- **Coherence costs responsiveness.** When one tile within a group could load detail faster than its siblings (because, for example, its chunks are already cached), the group-as-unit rule makes everyone wait for the slowest. Accepted: visible coherence is more valuable than per-tile responsiveness.
- **The "what about the tile the user is hovering on?" objection is rejected.** A natural extension request ("the user is clearly looking at tile 4 specifically; give it detail even if the group as a whole is in proxy mode") is not honored. The principle and this ADR together establish that this kind of per-tile override is out of scope. If user-research evidence ever justifies revisiting, the path is to supersede this ADR rather than to relax it ad hoc.
- **The group's projected diagonal is the input to mode selection, not any individual tile's.** This is what the rule looks like in practice: `chooseEntityMode` takes the group's max projected diagonal, not a specific tile's.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/modes.ts::groupMembers` — bundles tile entities by their parent group so the rest of the pipeline operates on groups.
- `lucida-web/src/pipeline/planning/modes.ts::assignModes` — iterates groups; calls `chooseEntityMode` once per group with the group's projected diagonal. (The default chunk-only path uses `modes.ts::assignCoarseDetailModes`, which emits one `TileEntry` per tile and no group-as-unit, per the supersession header above.)
- `lucida-web/src/pipeline/planning/chunks.ts::iterateChunks` — short-circuits for `group-as-proxy` entries before reading any tile-specific data.
- Test coverage for the three-tier-with-catalog behavior (including "two groups at different zooms get different modes") lives in the planning test suite under `pipeline/planning/`.

## Related

- [Principles — Planning Domain](../principles/planning.md) — the framework this decision lives within
- [Planning Domain](../systems/subsystems/planning-domain.md) — subsystem article; the "Invariants" section
- [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md) — section 1c (single vs collection divergence) and section 3b (promotion)
- PRD #545 — the work item during which this ADR was captured
</content>
