/**
 * Worker-side CPU cache of decoded **label** Z-slices, and the point-sample
 * (`sampleLabelValue`) that a hover tooltip reads.
 *
 * Why the cache exists: the label chunks the worker decodes for the r32uint
 * atlas are written straight to a GPU texture, and reading a single texel back
 * from the GPU is async + awkward. A hover pick needs one integer id *now*, so
 * we retain the decoded `Uint32Array` for each resident label chunk's
 * **current-Z slice** (chunkY×chunkX, row-major, stride = chunkX) on the CPU.
 * The store is bounded by residency — it mirrors the atlas's slot set: a chunk's
 * slice is dropped the moment that chunk is evicted, goes stale on a Z change,
 * or its dataset is removed (the slice-4 removal path). It never grows
 * unbounded across the worker's lifetime.
 *
 * The `uint32` id is retained untruncated (ids > 65535 survive), matching the
 * r32uint atlas — a value read here indexes the same LUT the shader tints with.
 *
 * Coordinates: the hover pick (`WasmScene::pick_annotation_voxel`) yields a
 * voxel in the dataset's **primary** (intensity) member level-0 frame. The main
 * thread normalizes that to fractional `[fx, fy, fz]` in `[0, 1]` (dividing by
 * `dataset_volume_shape`) before crossing the worker boundary, so this module is
 * independent of any resolution difference between the intensity image and the
 * label image — it just multiplies the fraction by the label member's own level
 * dims. `fz` is informational (the atlas caches the current display slice, which
 * is what the pick's Z refers to); the sample reads that resident slice.
 */

import { parseCompositeKey } from "../chunkKeys.ts";

/** Per-level geometry of a label member, captured when a chunk of that level is
 * cached. `[Z, Y, X]` throughout, matching `LodIndirectionMeta`. */
export interface LabelLevelGeom {
  level: number;
  levelDims: [number, number, number];
  gridDims: [number, number, number];
  chunkDims: [number, number, number];
}

/** One cached label chunk slice: the decoded current-Z plane plus the valid
 * (non-padded) extent written to the atlas. Row-major, row stride = chunkX. */
interface CachedSlice {
  level: number;
  cx: number;
  cy: number;
  chunkW: number;
  chunkH: number;
  data: Uint32Array;
}

/**
 * Per-session store of decoded label slices + label member geometry. Held on
 * {@link RendererState} and mutated by the upload path; queried by
 * {@link sampleLabelValue}. Pure data + Maps — no GPU coupling, so it is unit
 * testable off-thread.
 */
export class LabelSampleStore {
  /** compositeKey (`memberId|chunkKey`) → decoded current-Z slice. Mirrors the
   * atlas slot set: entries are added on upload, dropped on eviction/stale/removal. */
  private slices = new Map<string, CachedSlice>();
  /** memberId → its per-level geometry (ascending level). Captured lazily as
   * chunks arrive so the sample can walk finest→coarsest resident level. */
  private geomByMember = new Map<string, LabelLevelGeom[]>();
  /** datasetId → labelIndex → set of memberIds, from cold state. Resolves which
   * member(s) the `label_index`-th label overlay maps to. A set (not a single
   * id) so a multi-channel display — where the same label entry can surface
   * under more than one channel-suffixed memberId — still finds its resident
   * chunks under whichever memberId they uploaded. */
  private labelMembers = new Map<string, Map<number, Set<string>>>();

  /**
   * Record a label member's per-level geometry (idempotent per level). Called on
   * every label chunk upload with the level's `LodIndirectionMeta` fields.
   */
  recordGeom(memberId: string, geom: LabelLevelGeom): void {
    let levels = this.geomByMember.get(memberId);
    if (!levels) {
      levels = [];
      this.geomByMember.set(memberId, levels);
    }
    const existing = levels.find((l) => l.level === geom.level);
    if (existing) {
      existing.levelDims = geom.levelDims;
      existing.gridDims = geom.gridDims;
      existing.chunkDims = geom.chunkDims;
    } else {
      levels.push(geom);
      levels.sort((a, b) => a.level - b.level);
    }
  }

  /**
   * Retain the decoded current-Z slice for one resident label chunk. `data` is
   * the chunkY×chunkX plane the upload path wrote to the atlas; we copy it so the
   * cache is independent of the (possibly recycled) source buffer and stays
   * exactly one plane per resident chunk.
   */
  putSlice(
    memberId: string,
    chunkKey: string,
    level: number,
    cx: number,
    cy: number,
    chunkW: number,
    chunkH: number,
    data: Uint32Array,
  ): void {
    const compositeKey = `${memberId}|${chunkKey}`;
    // Copy: `data` may be a zero-copy view into the transferred chunk buffer.
    // A per-resident-chunk copy keeps the store self-contained and bounded.
    this.slices.set(compositeKey, {
      level,
      cx,
      cy,
      chunkW,
      chunkH,
      data: data.slice(),
    });
  }

  /** Drop a single chunk's cached slice (chunk evicted from the atlas). */
  evict(compositeKey: string): void {
    this.slices.delete(compositeKey);
  }

  /**
   * Drop the cached slices for a set of composite keys whose chunk went stale
   * after a Z change (the atlas marks these in `staleSliceKeys`). The fresh
   * slice for the new Z is re-cached on its next upload.
   */
  invalidateStale(compositeKeys: Iterable<string>): void {
    for (const key of compositeKeys) this.slices.delete(key);
  }

  /**
   * Record which member(s) each label overlay index maps to for a dataset.
   * Called on cold state; replaces the dataset's prior entry so a re-layout /
   * channel change stays correct.
   */
  setLabelMembers(
    datasetId: string,
    labelMembers: Map<number, Set<string>>,
  ): void {
    if (labelMembers.size > 0) {
      this.labelMembers.set(datasetId, labelMembers);
    } else {
      this.labelMembers.delete(datasetId);
    }
  }

  /**
   * Remove everything owned by a dataset — its label→member map, primary dims,
   * every cached slice for its label members, and their geometry. Called from
   * the worker's `removeLayerResources` (slice-4 removal path) so a dropped
   * dataset leaks nothing.
   */
  removeDataset(datasetId: string): void {
    const labelMembers = this.labelMembers.get(datasetId);
    if (labelMembers) {
      const memberSet = new Set<string>();
      for (const members of labelMembers.values()) {
        for (const m of members) memberSet.add(m);
      }
      for (const memberId of memberSet) this.geomByMember.delete(memberId);
      for (const key of [...this.slices.keys()]) {
        const parsed = parseCompositeKey(key);
        if (parsed && memberSet.has(parsed.memberId)) this.slices.delete(key);
      }
    }
    this.labelMembers.delete(datasetId);
  }

  /**
   * Sample the label integer id at a fractional position for the `labelIndex`-th
   * label overlay of `datasetId`.
   *
   * `frac` is `[fx, fy, fz]` in `[0, 1]`, the picked voxel normalized by the
   * dataset's primary shape. Reads the **finest resident** level (smallest level
   * number with a chunk covering the point) so a fused coarse id is never
   * reported. Returns `0` when nothing resolves — no such label/member, no
   * resident chunk covering the point, or the point is out of range — matching
   * the label convention that 0 is background / "no label".
   */
  sample(
    datasetId: string,
    labelIndex: number,
    frac: [number, number, number],
  ): number {
    const members = this.labelMembers.get(datasetId)?.get(labelIndex);
    if (!members || members.size === 0) return 0;

    const [fx, fy, fz] = frac;
    // Out-of-volume fractions never hit a label.
    if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1 || fz < 0 || fz > 1) return 0;

    // A label maps to one memberId in single-channel display, possibly several
    // under multi-channel; return the first resident hit across them.
    for (const memberId of members) {
      const value = this.sampleMember(memberId, fx, fy);
      if (value !== 0) return value;
    }
    return 0;
  }

  /** Sample one label member: walk its resident levels finest (smallest level
   * number) → coarsest and return the first covered id, so the reported value is
   * the crispest available and never a coarse fusion. `0` if nothing resident
   * covers the point. */
  private sampleMember(memberId: string, fx: number, fy: number): number {
    const levels = this.geomByMember.get(memberId);
    if (!levels || levels.length === 0) return 0;
    for (const geom of levels) {
      const [, lh, lw] = geom.levelDims;
      const [, chY, chX] = geom.chunkDims;
      const [, gridY, gridX] = geom.gridDims;
      if (lw <= 0 || lh <= 0 || chX <= 0 || chY <= 0) continue;

      // Fraction → this level's voxel, clamped to the last valid voxel.
      const vx = Math.min(Math.floor(fx * lw), lw - 1);
      const vy = Math.min(Math.floor(fy * lh), lh - 1);
      const cx = Math.floor(vx / chX);
      const cy = Math.floor(vy / chY);
      if (cx < 0 || cy < 0 || cx >= gridX || cy >= gridY) continue;

      const localX = vx - cx * chX;
      const localY = vy - cy * chY;

      // Any resident chunk at (level, cy, cx) for this member holds the current-Z
      // slice regardless of the key's t/c/z, so match the (level, y, x) triple.
      const hit = this.findResidentSlice(memberId, geom.level, cy, cx);
      if (!hit) continue;
      // Guard against the padded region of an edge chunk.
      if (localX >= hit.chunkW || localY >= hit.chunkH) continue;

      const idx = localY * chX + localX;
      if (idx < 0 || idx >= hit.data.length) continue;
      // `>>> 0` keeps the value an unsigned 32-bit integer (ids > 2^31 survive).
      return hit.data[idx] >>> 0;
    }
    return 0;
  }

  /** Find a resident cached slice for `(memberId, level, cy, cx)`, ignoring the
   * t/c/z components of the chunk key (the cache holds the current display
   * slice). Returns null if no such chunk is resident. */
  private findResidentSlice(
    memberId: string,
    level: number,
    cy: number,
    cx: number,
  ): CachedSlice | null {
    for (const [key, slice] of this.slices) {
      if (slice.level !== level || slice.cy !== cy || slice.cx !== cx) continue;
      const parsed = parseCompositeKey(key);
      if (parsed?.memberId === memberId) return slice;
    }
    return null;
  }
}
