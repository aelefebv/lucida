/**
 * Pure functions that derive `LayoutSpec` values from a `DatasetManifest`.
 * The bridge auto-registers these browser-authored layouts when a dataset
 * opens. A builder returns `null` when the dataset has no usable source
 * default; `derivedBuildersFor` filters those out.
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
 * Hash indexes over a manifest's relational scans, built once per call so
 * per-placement footprint lookups are O(1). Without them a wide
 * collection pays `placements × (images + entities + transforms)` array
 * scans — millions for hundreds of groups × tens of thousands of tiles.
 * Every map keeps the first match, mirroring `Array.find` semantics.
 */
export interface ManifestIndex {
  /** Owner entity id → first image it owns. */
  imageByOwner: Map<string, DatasetManifest["images"][number]>;
  /** Parent entity id → child entities, in manifest order. */
  childrenByParent: Map<string, DatasetManifest["entities"]>;
  /** `from` id → `to` id → first matching transform edge. */
  transformByEdge: Map<string, Map<string, DatasetManifest["transforms"][number]>>;
}

export function buildManifestIndex(manifest: DatasetManifest): ManifestIndex {
  const imageByOwner = new Map<string, DatasetManifest["images"][number]>();
  for (const img of manifest.images) {
    if (!imageByOwner.has(img.owner)) imageByOwner.set(img.owner, img);
  }
  const childrenByParent = new Map<string, DatasetManifest["entities"]>();
  for (const e of manifest.entities) {
    if (e.parent === undefined || e.parent === null) continue;
    const siblings = childrenByParent.get(e.parent);
    if (siblings) {
      siblings.push(e);
    } else {
      childrenByParent.set(e.parent, [e]);
    }
  }
  const transformByEdge = new Map<string, Map<string, DatasetManifest["transforms"][number]>>();
  for (const t of manifest.transforms) {
    let byTo = transformByEdge.get(t.from);
    if (!byTo) {
      byTo = new Map();
      transformByEdge.set(t.from, byTo);
    }
    if (!byTo.has(t.to)) byTo.set(t.to, t);
  }
  return { imageByOwner, childrenByParent, transformByEdge };
}

/** An XY rectangle in level-0 voxel units, `min` and `max` as `[x, y]`. */
export interface VoxelRect {
  min: [number, number];
  max: [number, number];
}

/**
 * The XY rectangle a placed entity covers, relative to its placement, or null
 * when nothing under it has a level 0.
 *
 *   - Image entity (owns an image directly) → that image's level-0 tile.
 *   - Group entity (no direct image; has child tiles) → bounding box of all
 *     child tiles, computed as `(tile_offset + tile_footprint)`. The
 *     tile→group TransformEdge contributes the offset (matrix[12], [13]).
 *
 * This matches `lucida-core::scene::resolve_entity_position`, which composes
 * tile positions from `group_position + tile_offset_within_group`, so the
 * rectangle covers what the 2D view draws for the entity.
 */
export function entityExtent(index: ManifestIndex, entityId: string): VoxelRect | null {
  const directImg = index.imageByOwner.get(entityId);
  if (directImg) {
    const lvl0 = directImg.multiscale.levels[0];
    if (!lvl0) return null;
    return { min: [0, 0], max: [lvl0.shape[Axis.X] ?? 1, lvl0.shape[Axis.Y] ?? 1] };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const child of index.childrenByParent.get(entityId) ?? []) {
    const childImg = index.imageByOwner.get(child.id);
    if (!childImg) continue;
    const lvl0 = childImg.multiscale.levels[0];
    if (!lvl0) continue;
    const footprintY = lvl0.shape[Axis.Y] ?? 1;
    const footprintX = lvl0.shape[Axis.X] ?? 1;
    const t = index.transformByEdge.get(child.id)?.get(entityId);
    const tx = t?.transform.matrix[12] ?? 0;
    const ty = t?.transform.matrix[13] ?? 0;
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx + footprintX > maxX) maxX = tx + footprintX;
    if (ty + footprintY > maxY) maxY = ty + footprintY;
  }

  if (!isFinite(minX)) return null;
  return { min: [minX, minY], max: [maxX, maxY] };
}

/**
 * Footprint `[height, width]` in voxel units for a placed entity. Dense
 * packing needs the group's footprint, which scales with tiles-per-group, not
 * just one tile's.
 */
function entityFootprintYX(index: ManifestIndex, entityId: string): [number, number] {
  const extent = entityExtent(index, entityId);
  if (!extent) return [1, 1];
  return [
    Math.max(1, extent.max[1] - extent.min[1]),
    Math.max(1, extent.max[0] - extent.min[0]),
  ];
}

/** Largest `[Y, X]` footprint across all source-default placements. Used as
 *  the per-cell base stride for dense packing — guarantees no two placed
 *  entities overlap regardless of whether placements are at the group or
 *  image level. */
function maxPlacementFootprintYX(manifest: DatasetManifest): [number, number] {
  const placements = sourceDefaultPlacements(manifest);
  if (!placements) return [1, 1];
  const index = buildManifestIndex(manifest);
  let maxY = 0;
  let maxX = 0;
  for (const p of placements) {
    const [y, x] = entityFootprintYX(index, p.entity_id);
    if (y > maxY) maxY = y;
    if (x > maxX) maxX = x;
  }
  if (maxY <= 0) maxY = 1;
  if (maxX <= 0) maxX = 1;
  return [maxY, maxX];
}

/** Largest `[Y, X]` image tile at level 0 across all images. Used as the
 *  inter-group gap so adjacent groups are visibly separated by at least one
 *  tile-width — distinct from any intra-group tile spacing. */
function maxImageFootprintYX(manifest: DatasetManifest): [number, number] {
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
 * `entity_footprint + one_tile` — the footprint guarantees no overlap
 * (group bbox for collection placements, image tile for image-level placements),
 * and the extra tile creates a visible inter-group gap that is always
 * larger than any intra-group tile spacing. Returns null if fewer than 2
 * entities.
 */
export function buildDenseSquareLayout(manifest: DatasetManifest): LayoutSpec | null {
  const placements = sourceDefaultPlacements(manifest);
  if (!placements || placements.length < 2) return null;

  const [footprintY, footprintX] = maxPlacementFootprintYX(manifest);
  const [gapY, gapX] = maxImageFootprintYX(manifest);
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
