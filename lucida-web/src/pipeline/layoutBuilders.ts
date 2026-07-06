/**
 * Layout builders — pure functions that derive `LayoutSpec` values from a
 * `DatasetManifest`. Used by the bridge to auto-register browser-authored
 * derived layouts when a dataset is opened.
 *
 * Today's two builders:
 *   - `buildCollectionGridLayout`  : a verbatim copy of the source default
 *     layout, registered under id `"derived:collection-grid"`.
 *   - `buildDenseSquareLayout`: source placements packed into a tight
 *     ceil(sqrt(N)) x ceil(N/cols) grid, registered under id
 *     `"derived:dense-square"`.
 *
 * Both return `null` when the dataset has no usable source default
 * (or fewer than 2 placements for the dense builder); `derivedBuildersFor`
 * filters those out so callers can iterate without null checks.
 */

import { Axis } from "../axes.ts";
import type { DatasetManifest, LayoutSpec } from "../manifestTypes.ts";

/** Find the placements from the source default layout, if any. */
function sourceDefaultPlacements(manifest: DatasetManifest): LayoutSpec["placements"] | null {
  const def =
    manifest.source_layouts.find((l) => l.id === manifest.default_layout_id) ??
    manifest.source_layouts[0];
  return def?.placements ?? null;
}

/**
 * Footprint `[height, width]` in voxel units for a placed entity.
 *
 *   - Image entity (owns an image directly) → that image's level-0 FOV.
 *   - Well entity (no direct image; has child fields) → bounding box of all
 *     child fields, computed as `(field_offset + field_FOV)`. The
 *     field→well TransformEdge contributes the offset (matrix[12], [13]).
 *
 * This matches `lucida-core::scene::find_entity_position`, which composes
 * field positions from `well_position + field_offset_within_well`. For
 * dense packing we therefore need the WELL's footprint (which scales with
 * fields-per-well), not just one field's FOV.
 */
function entityFootprintYX(manifest: DatasetManifest, entityId: string): [number, number] {
  const directImg = manifest.images.find((i) => i.owner === entityId);
  if (directImg) {
    const lvl0 = directImg.multiscale.levels[0];
    if (!lvl0) return [1, 1];
    return [lvl0.shape[Axis.Y] ?? 1, lvl0.shape[Axis.X] ?? 1];
  }

  const children = manifest.entities.filter((e) => e.parent === entityId);
  if (children.length === 0) return [1, 1];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const child of children) {
    const childImg = manifest.images.find((i) => i.owner === child.id);
    if (!childImg) continue;
    const lvl0 = childImg.multiscale.levels[0];
    if (!lvl0) continue;
    const fovY = lvl0.shape[Axis.Y] ?? 1;
    const fovX = lvl0.shape[Axis.X] ?? 1;
    const t = manifest.transforms.find((t) => t.from === child.id && t.to === entityId);
    const tx = t?.transform.matrix[12] ?? 0;
    const ty = t?.transform.matrix[13] ?? 0;
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx + fovX > maxX) maxX = tx + fovX;
    if (ty + fovY > maxY) maxY = ty + fovY;
  }

  if (!isFinite(minX)) return [1, 1];
  return [Math.max(1, maxY - minY), Math.max(1, maxX - minX)];
}

/** Largest `[Y, X]` footprint across all source-default placements. Used as
 *  the per-cell base stride for dense packing — guarantees no two placed
 *  entities overlap regardless of whether placements are at the well or
 *  image level. */
function maxPlacementFootprintYX(manifest: DatasetManifest): [number, number] {
  const placements = sourceDefaultPlacements(manifest);
  if (!placements) return [1, 1];
  let maxY = 0;
  let maxX = 0;
  for (const p of placements) {
    const [y, x] = entityFootprintYX(manifest, p.entity_id);
    if (y > maxY) maxY = y;
    if (x > maxX) maxX = x;
  }
  if (maxY <= 0) maxY = 1;
  if (maxX <= 0) maxX = 1;
  return [maxY, maxX];
}

/** Largest `[Y, X]` image FOV at level 0 across all images. Used as the
 *  inter-well gap so adjacent wells are visibly separated by at least one
 *  field-width — distinct from any intra-well field spacing. */
function maxImageFovYX(manifest: DatasetManifest): [number, number] {
  let maxY = 0;
  let maxX = 0;
  for (const img of manifest.images) {
    const lvl0 = img.multiscale.levels[0];
    if (!lvl0) continue;
    const y = lvl0.shape[Axis.Y] ?? 0;
    const x = lvl0.shape[Axis.X] ?? 0;
    if (y > maxY) maxY = y;
    if (x > maxX) maxX = x;
  }
  if (maxY <= 0) maxY = 1;
  if (maxX <= 0) maxX = 1;
  return [maxY, maxX];
}

/**
 * Mirror the source default layout's placements verbatim under id
 * `"derived:collection-grid"`. Returns null if no source default exists.
 */
export function buildCollectionGridLayout(manifest: DatasetManifest): LayoutSpec | null {
  const placements = sourceDefaultPlacements(manifest);
  if (!placements) return null;
  return {
    id: "derived:collection-grid",
    name: "Collection grid",
    placements: placements.map((p) => ({
      entity_id: p.entity_id,
      position: [p.position[0], p.position[1]],
    })),
  };
}

/**
 * Pack source-default placements into a square-ish grid. Per-cell stride is
 * `entity_footprint + one_field_FOV` — the footprint guarantees no overlap
 * (well bbox for collection placements, image FOV for image-level placements),
 * and the extra field-FOV creates a visible inter-well gap that is always
 * larger than any intra-well field spacing. Returns null if fewer than 2
 * entities.
 */
export function buildDenseSquareLayout(manifest: DatasetManifest): LayoutSpec | null {
  const placements = sourceDefaultPlacements(manifest);
  if (!placements || placements.length < 2) return null;

  const [footprintY, footprintX] = maxPlacementFootprintYX(manifest);
  const [gapY, gapX] = maxImageFovYX(manifest);
  const strideY = footprintY + gapY;
  const strideX = footprintX + gapX;
  const cols = Math.ceil(Math.sqrt(placements.length));
  const denseplacements = placements.map((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      entity_id: p.entity_id,
      position: [col * strideX, row * strideY] as [number, number],
    };
  });

  return {
    id: "derived:dense-square",
    name: "Dense (square)",
    placements: denseplacements,
  };
}

/**
 * Convenience: returns the array of derived layouts for `manifest`,
 * filtering out nulls. Callers iterate this and feed each spec to
 * `LayoutRegistry.register`.
 */
export function derivedBuildersFor(manifest: DatasetManifest): LayoutSpec[] {
  const out: LayoutSpec[] = [];
  const grid = buildCollectionGridLayout(manifest);
  if (grid) out.push(grid);
  const dense = buildDenseSquareLayout(manifest);
  if (dense) out.push(dense);
  return out;
}
