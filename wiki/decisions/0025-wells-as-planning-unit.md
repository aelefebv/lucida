---
type: Decision
title: "Wells Are the Planning Unit on Plates"
description: "Chunk-only coarse/detail residency."
tags: [lucida, decision]
source_path: wiki/decisions/0025-wells-as-planning-unit.md
created: 2026-05-14
modified: 2026-06-25
---

# Wells Are the Planning Unit on Plates

Status: Superseded for chunk residency/fallback by
[Chunk-only coarse/detail residency](0039-chunk-only-coarse-detail-residency.md). Wells remain layout and
grouping concepts, but the new coarse/detail path may schedule residency per
field/image.

## Decision

On plate datasets, planning treats the **well** as the unit of decision. All fields belonging to one well agree on a single promotion mode (`well-as-proxy`, `fields-with-proxy-fallback`, or `fields-with-detail`); they share the same target LOD; they fetch and render together. Per-field divergence within a well is not permitted — fields cannot be in different modes from their siblings even when their individual projected sizes would warrant it.

A well in `well-as-proxy` mode does not enumerate detail chunks for any of its fields, regardless of any individual field's visibility, importance, or projected size.

This ADR is a *ratification* — the rule has existed in the code (in `groupByWell` and `assignModes`) and in the wiki article ([Planning Domain](../systems/subsystems/planning-domain.md) under "Invariants") since the three-tier promotion landed. It is captured here so future contributors do not relax it.

Cited in PRD #545.

## Why

A plate well is a perceptual unit. Users read "well B7" — they do not read "field 4 of well B7 separately from field 5 of well B7." A system that gives different fields within a well different representations creates visible patchwork that reads as a rendering defect, not as informative variation. The user cannot tell whether the patchwork reflects the data, the camera position, or a bug; the most charitable interpretation is "something is broken."

This decision honors [Principles — Planning Domain](../principles/planning.md#3-wells-are-coherent-visual-units). The principle is the abstract claim ("wells are coherent visual units"); this ADR is the concrete consequence in planning's structure (mode is assigned per well group; the well's projected diagonal — not any individual field's — is the input to mode selection).

## Tradeoffs

- **Coherence costs responsiveness.** When one field within a well could load detail faster than its siblings (because, for example, its chunks are already cached), the well-as-unit rule makes everyone wait for the slowest. Accepted: visible coherence is more valuable than per-field responsiveness.
- **The "what about the field the user is hovering on?" objection is rejected.** A natural extension request ("the user is clearly looking at field 4 specifically; give it detail even if the well as a whole is in proxy mode") is not honored. The principle and this ADR together establish that this kind of per-field override is out of scope. If user-research evidence ever justifies revisiting, the path is to supersede this ADR rather than to relax it ad hoc.
- **The well's projected diagonal is the input to mode selection, not any individual field's.** This is what the rule looks like in practice: `chooseEntityMode` takes the well-group's max projected diagonal, not a specific field's.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/modes.ts::groupByWell` — bundles field entities by their parent well so the rest of the pipeline operates on well groups.
- `lucida-web/src/pipeline/planning/modes.ts::assignModes` — iterates well groups; calls `chooseEntityMode` once per group with the group's projected diagonal. (Legacy path: the default chunk-only path uses `modes.ts::assignCoarseDetailModes`, which emits one `FieldEntry` per field and no well-as-unit, per the supersession header above.)
- `lucida-web/src/pipeline/planning/chunks.ts::iterateChunks` — short-circuits for `well-as-proxy` entries before reading any field-specific data.
- Test coverage for the legacy three-tier-with-catalog behavior (including "two wells at different zooms get different modes") lives in the planning test suite under `pipeline/planning/`.

## Related

- [Principles — Planning Domain](../principles/planning.md) — the framework this decision lives within
- [Planning Domain](../systems/subsystems/planning-domain.md) — subsystem article; the "Invariants" section
- [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md) — section 1c (single vs plate divergence) and section 3b (promotion)
- PRD #545 — the work item during which this ADR was captured
