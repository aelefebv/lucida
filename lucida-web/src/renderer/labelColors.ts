/**
 * Categorical colors for integer segmentation-label ids.
 *
 * A label mask stores an integer id per voxel; id 0 is background. Each
 * distinct id renders as a distinct, opaque color so neighbouring objects
 * read apart at a glance. Ids come from arbitrary uint32 masks and
 * routinely exceed the 16-bit range, so the color derivation hashes the
 * FULL 32-bit id — masking to 16 bits would collapse every id above
 * 65535 onto a handful of colors.
 *
 * The fallback color is produced by a deterministic hash in fixed-point
 * integer arithmetic (id -> HSV -> RGB), so it can be reproduced
 * bit-for-bit inside `slice.wgsl` (see `labelGlasbey` there). The
 * TS<->WGSL agreement is locked by `labelColorParity.test.ts`, which
 * ports the shader math and cross-checks it against {@link glasbeyRgb}.
 * Keep the two implementations in lockstep: any change here must be
 * mirrored in the shader and vice versa.
 */

export type RGBA = [number, number, number, number]; // each 0..255

/**
 * 32-bit integer avalanche (the MurmurHash3 finalizer). Spreads
 * neighbouring ids to unrelated outputs so `id` and `id + 1` get visibly
 * different colors.
 *
 * Written with `Math.imul` + `>>> 0` so every step matches WGSL's native
 * wrap-around `u32` arithmetic exactly — plain `*` would overflow past
 * 2^53 and diverge from the shader.
 */
function fmix32(value: number): number {
  let h = value >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/** Integer division truncating toward zero (matches WGSL `u32 / u32`). */
function idiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/**
 * Deterministic, well-distributed fallback color for a label id.
 *
 * Distinct across the whole uint32 range: the id is hashed twice (a
 * second round decorrelates the bits feeding hue vs. saturation/value),
 * then mapped through a fixed-point integer HSV->RGB so distinct ids land
 * on distinct, saturated, mid-to-bright colors. Returns three bytes
 * (0..255); id 0 is background and never reaches here (see
 * {@link labelColor}).
 *
 * The hue spans all six sextants (0..1529); saturation and value vary
 * over narrow high ranges so colors stay vivid rather than washing out.
 */
export function glasbeyRgb(value: number): [number, number, number] {
  const a = fmix32(value);
  const b = fmix32(a);

  const hue = a % 1530; // 0..1529 -> six 255-wide sextants
  const sat = 200 + (b % 56); // 200..255
  const val = 205 + (idiv(b, 256) % 51); // 205..255

  const seg = idiv(hue, 255); // 0..5
  const off = hue % 255; // 0..254

  const p = idiv(val * (255 - sat), 255);
  const q = idiv(val * (255 - idiv(sat * off, 255)), 255);
  const t = idiv(val * (255 - idiv(sat * (255 - off), 255)), 255);

  let r = 0;
  let g = 0;
  let bl = 0;
  if (seg === 0) {
    r = val; g = t; bl = p;
  } else if (seg === 1) {
    r = q; g = val; bl = p;
  } else if (seg === 2) {
    r = p; g = val; bl = t;
  } else if (seg === 3) {
    r = p; g = q; bl = val;
  } else if (seg === 4) {
    r = t; g = p; bl = val;
  } else {
    r = val; g = p; bl = q;
  }
  return [r, g, bl];
}

/**
 * Resolve a label id to its rgba (each channel 0..255).
 *
 *   - id 0 (background) -> fully transparent.
 *   - id present in `explicit` (the OME `image-label.colors` table) ->
 *     that RGB, so a dataset's declared palette is honored, but ALPHA is
 *     normalized to opaque (255) — the overlay's transparency is controlled
 *     uniformly by the per-label opacity, not by a per-id declared alpha.
 *   - otherwise -> the deterministic {@link glasbeyRgb} fallback, opaque.
 *
 * Why normalize alpha: some writers author `image-label.colors` with a
 * partial alpha (e.g. 128). Respecting it per id would render those cells
 * semi-transparent while glasbey-fallback ids (opaque) stayed solid — a
 * confusing patchwork the opacity slider can't correct. So alpha is uniform
 * and the layer's label opacity is the single transparency control.
 *
 * `explicit` keys are the raw integer ids (which may exceed 65535).
 *
 * NOTE: `0xFFFFFFFF` (4294967295) doubles as the renderer's no-data
 * sentinel — the slice shader treats it (like id 0) as fully transparent
 * before ever computing a color, so this function is not consulted for it
 * on the GPU path. It still hashes to a valid color here if called
 * directly (e.g. a legitimately-declared max-u32 id in `explicit`).
 */
export function labelColor(
  value: number,
  explicit?: ReadonlyMap<number, RGBA>,
): RGBA {
  if (value === 0) return [0, 0, 0, 0];
  if (explicit) {
    const declared = explicit.get(value);
    // Declared RGB honored; alpha normalized to opaque so overlay
    // transparency is uniform (layer opacity is the sole control).
    if (declared) return [declared[0], declared[1], declared[2], 255];
  }
  const [r, g, b] = glasbeyRgb(value);
  return [r, g, b, 255];
}

/**
 * Upper bound on declared colors uploaded to (and linearly scanned by) the
 * categorical shader. The OME parser permits far more (dense per-instance
 * color files run to tens of thousands), but the shader scans the palette
 * per fragment, so an unbounded palette would cost seconds/frame or trip a
 * GPU watchdog reset. Ids beyond this cap fall back to the glasbey hash.
 */
export const MAX_GPU_LABEL_COLORS = 256;

/**
 * Pack a declared palette into the flat `[id0, rgba0, id1, rgba1, ...]`
 * `u32` layout the shader's `labelColorFor` scans, capped at
 * {@link MAX_GPU_LABEL_COLORS} pairs. `rgba` is packed
 * `r | g<<8 | b<<16 | a<<24`. The declared RGB is preserved; the ALPHA byte
 * is forced to opaque (255) — matching {@link labelColor} — so a declared
 * partial alpha never makes some cells semi-transparent while glasbey ids
 * stay opaque. Overlay transparency is the layer opacity's job, uniformly.
 * Pure — no GPU.
 */
export function packLabelPalette(
  colors: ReadonlyArray<{ value: number; rgba: readonly [number, number, number, number] }>,
  maxColors = MAX_GPU_LABEL_COLORS,
): Uint32Array<ArrayBuffer> {
  const count = Math.min(colors.length, maxColors);
  const out = new Uint32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const { value, rgba } = colors[i];
    out[2 * i] = value >>> 0;
    // Alpha normalized to opaque (see doc): overlay opacity is uniform.
    out[2 * i + 1] =
      ((rgba[0] & 0xff) |
        ((rgba[1] & 0xff) << 8) |
        ((rgba[2] & 0xff) << 16) |
        (0xff << 24)) >>> 0;
  }
  return out;
}
