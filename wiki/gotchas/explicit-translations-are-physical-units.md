---
type: Gotcha
title: "Explicit Translations Are in Physical Units; Lucida Composes in Voxels"
description: "OME-Zarr stores explicitly-positioned tile translations in physical units inside coordinateTransformations.translation, while lucida composes everything in voxel units."
tags: [lucida, gotcha]
source_path: wiki/gotchas/explicit-translations-are-physical-units.md
created: 2026-04-18
modified: 2026-07-06
---

# Explicit Translations Are in Physical Units; Lucida Composes in Voxels

## The footgun

OME-Zarr stores an explicitly-positioned collection tile's translation in **physical units** inside `coordinateTransformations.translation`. Lucida composes everything downstream in **voxel units**. Forgetting to convert produces groups whose tiles scatter far outside the group's voxel bounds — a visible disaster.

[lucida-store](../systems/crates/lucida-store.md) `import.rs` does the conversion at import time, dividing the translation by the level-0 X/Y voxel scale before forming the `tile → group` transform.

## Where the conversion lives

`import_collection` in `lucida-store/src/import.rs`:

1. Parse the tile's `coordinateTransformations.translation` (last two values are X, Y).
2. Read the level-0 multiscales `scale` for X and Y from the same tile's metadata.
3. Convert: `voxel_x = physical_x / scale_x`, `voxel_y = physical_y / scale_y`.
4. Use the voxel values when building the `tile → group` `VoxelTransform`.

A defensive check: if `scale_x` or `scale_y` is missing or non-finite (`!isfinite || == 0.0`), fall back to `1.0` (pass-through) and emit a warning. This keeps malformed metadata from producing NaN positions.

## Tests covering the conversion

- `explicit_translations_normalized_to_voxel_units` — the happy path.
- `missing_voxel_scale_falls_back_to_unit_scale` — defensive case.
- `zero_voxel_scale_falls_back_with_warning` — defensive case for divide-by-zero.
- `grid_collections_unaffected` — derived-positioned collections (no translations) shouldn't be affected by the scale-conversion code path.

## What to do

- **Don't bypass `import_dataset`** when reading OME-Zarr collection metadata. The conversion is the kind of thing that's easy to forget.
- **If you write a new metadata parser** (e.g. for non-OME formats), do the unit conversion at parse time and document the expected unit on the structured output.
- **If a collection looks "wrong" — tiles scattered, group bounds blown out** — first check that the source data is being interpreted with the right `positioning_mode` (`Explicit` vs `Derived`) and that the voxel scale is sane.

## Why this conversion lives in the importer

The downstream layers ([Planning Domain](../systems/subsystems/planning-domain.md), [GPU Residency](../systems/subsystems/gpu-residency.md), shaders) all assume voxel units. Pushing the conversion to import means they don't have to thread "what unit am I in" through every transform. The cost is one place that has to know the unit story; the alternative would have been every consumer needing to know.

## Related

- [lucida-store](../systems/crates/lucida-store.md)
- [lucida-content](../systems/crates/lucida-content.md) — the downstream `VoxelTransform` consumers
- The `import_collection_with_explicit_positions` test in `lucida-store/src/import.rs`
