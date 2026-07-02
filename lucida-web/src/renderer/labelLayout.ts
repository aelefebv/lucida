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
