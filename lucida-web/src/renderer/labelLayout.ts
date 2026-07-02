/**
 * Spatial footprint of a label overlay in its source image's voxel frame.
 *
 * A label carries its own multiscale geometry: its level-0 grid can be
 * coarser than the intensity image it overlays (segmentations are often
 * downsampled). Rendering a label at its raw pixel dimensions would shrink
 * it to 1/downsample of the image and misalign it. Instead the label quad
 * must cover the same physical field of view as the source image, so it is
 * sized in the SOURCE's full-resolution voxel units.
 *
 * The 5D axis order is the canonical `[T, C, Z, Y, X]`, so X is index 4
 * and Y is index 3.
 */

/** Level-0 geometry: 5D `shape` and `scale`, canonical `[T, C, Z, Y, X]`. */
export interface Level0 {
  shape: number[];
  scale: number[];
}

const AXIS_T = 0;
const AXIS_Z = 2;
const AXIS_Y = 3;
const AXIS_X = 4;

/** A finite positive scale, or `1` for missing/zero/NaN — never divide by it into NaN. */
function safeScale(scale: number[] | undefined, axis: number): number {
  const v = scale?.[axis] ?? 1;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** A finite non-negative count, or `0` for missing/NaN. */
function safeCount(shape: number[] | undefined, axis: number): number {
  const v = shape?.[axis] ?? 0;
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * A physical extent equals `count * scale`. To express the label's extent
 * in the source's voxel units, divide by the source's scale on the same
 * axis. Guards against a missing/zero/NaN scale by treating it as unit
 * scale, which degrades to the label's own pixel size rather than emitting
 * a NaN that could reach a chunk key or a texture size.
 */
function footprintAxis(
  labelShape: number[],
  labelScale: number[],
  sourceScale: number[],
  axis: number,
): number {
  const labelCount = safeCount(labelShape, axis);
  const labelUnit = safeScale(labelScale, axis);
  const sourceUnit = safeScale(sourceScale, axis);
  return (labelCount * labelUnit) / sourceUnit;
}

/**
 * Footprint (width/height, in the source's full-res voxel units) the label
 * overlay must occupy to stay aligned with its source image:
 *
 *   dataW = label.shape[X] * label.scale[X] / source.scale[X]
 *   dataH = label.shape[Y] * label.scale[Y] / source.scale[Y]
 *
 * A 4x-downsampled label (e.g. 87 px at scale 4 over a 348 px image at
 * scale 1) reports 348, matching the source rather than its own 87.
 */
export function labelFootprint(
  source: Level0,
  label: Level0,
): { dataW: number; dataH: number } {
  return {
    dataW: footprintAxis(label.shape, label.scale, source.scale, AXIS_X),
    dataH: footprintAxis(label.shape, label.scale, source.scale, AXIS_Y),
  };
}

/**
 * The label's own index on `axis` that lines up physically with a source
 * index on the same axis. An axis can be sampled/extended independently of
 * the others, so map by physical position (`sourceIdx * source.scale /
 * label.scale`) and clamp into the label's extent. Reduces to identity when
 * label and source share that axis' scale + extent (the common case). NaN-
 * and zero-scale-safe (never emits a NaN index).
 */
function labelAxisIndex(sourceIdx: number, source: Level0, label: Level0, axis: number): number {
  const sourceUnit = safeScale(source.scale, axis);
  const labelUnit = safeScale(label.scale, axis);
  const extent = safeCount(label.shape, axis);
  const idx = Number.isFinite(sourceIdx) ? sourceIdx : 0;
  const mapped = Math.round((idx * sourceUnit) / labelUnit);
  const clamped = Math.min(Math.max(mapped, 0), Math.max(extent - 1, 0));
  return Number.isFinite(clamped) ? clamped : 0;
}

/**
 * The label's own full-resolution Z lining up with a source full-res Z.
 * Used by BOTH the request emitter and the delivery path so the fetched
 * chunk's Z and the worker's slice pick agree.
 */
export function labelDepthZ(sourceZ: number, source: Level0, label: Level0): number {
  return labelAxisIndex(sourceZ, source, label, AXIS_Z);
}

/**
 * The label's own timepoint lining up with a source timepoint. A time-
 * invariant label (T=1) maps every source t to t=0, so it stays visible as
 * the source scrubs through time instead of requesting non-existent chunks.
 */
export function labelTimeIndex(sourceT: number, source: Level0, label: Level0): number {
  return labelAxisIndex(sourceT, source, label, AXIS_T);
}

/** Ratio of the label's physical extent to the source's on `axis`, or `1`
 *  when either is missing/zero (never a zero/NaN scale factor). */
function extentRatio(label: Level0, source: Level0, axis: number): number {
  const labelExtent = safeCount(label.shape, axis) * safeScale(label.scale, axis);
  const sourceExtent = safeCount(source.shape, axis) * safeScale(source.scale, axis);
  if (!(sourceExtent > 0) || !(labelExtent > 0)) return 1;
  const r = labelExtent / sourceExtent;
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/**
 * The model matrix (and inverse) that maps a LABEL's `[0,1]^3` cube to world
 * space, given the SOURCE member's model matrix + inverse. The 3D analog of
 * {@link labelFootprint}: a label overlays its source's physical extent, so
 * it inherits the source's world origin/orientation, scaled per axis so the
 * cube spans the LABEL's own physical extent (`shape * scale`). For a
 * spec-compliant label — same physical extent as its source, only downsampled
 * — every ratio is `1` and the matrices pass through unchanged.
 *
 * Both matrices are column-major 4×4. `M_label = M_source · diag(rx, ry, rz, 1)`
 * scales the source's basis columns; the inverse is
 * `diag(1/rx, 1/ry, 1/rz, 1) · M_source⁻¹`, which scales the inverse's rows —
 * so no general matrix inversion is needed (the source inverse is reused).
 */
export function labelModelMatrices(
  sourceModel: Float32Array,
  sourceInv: Float32Array,
  source: Level0,
  label: Level0,
): { model: Float32Array; inv: Float32Array } {
  const rx = extentRatio(label, source, AXIS_X);
  const ry = extentRatio(label, source, AXIS_Y);
  const rz = extentRatio(label, source, AXIS_Z);

  // M · diag(rx, ry, rz, 1): scale columns 0, 1, 2 (local x/y/z basis).
  const model = new Float32Array(sourceModel);
  for (let i = 0; i < 4; i++) {
    model[i] *= rx;      // column 0
    model[4 + i] *= ry;  // column 1
    model[8 + i] *= rz;  // column 2
  }

  // diag(1/rx, 1/ry, 1/rz, 1) · M⁻¹: scale rows 0, 1, 2 (column-major → stride 4).
  const inv = new Float32Array(sourceInv);
  const irx = 1 / rx, iry = 1 / ry, irz = 1 / rz;
  for (let c = 0; c < 4; c++) {
    inv[0 + 4 * c] *= irx; // row 0
    inv[1 + 4 * c] *= iry; // row 1
    inv[2 + 4 * c] *= irz; // row 2
  }

  return { model, inv };
}
