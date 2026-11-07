/**
 * Categorical colors for integer label ids; id 0 is background. Ids
 * routinely exceed 16 bits, so the hash uses the full 32-bit id.
 *
 * The fallback color uses fixed-point integer math (id -> HSV -> RGB) so
 * `labelGlasbey` in `slice.wgsl` reproduces it bit for bit.
 * `labelColorParity.test.ts` locks the two together: change both or neither.
 */

export type RGBA = [number, number, number, number]; // each 0..255

/**
 * 32-bit integer avalanche (the MurmurHash3 finalizer). Spreads
 * neighbouring ids to unrelated outputs so `id` and `id + 1` get visibly
 * different colors.
 *
 * Written with `Math.imul` + `>>> 0` so every step matches WGSL's
 * wrap-around `u32` arithmetic. Plain `*` would overflow past 2^53 and
 * diverge from the shader.
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
 * Deterministic fallback RGB for a nonzero label id. The second hash round
 * decorrelates hue from saturation and value, which stay in narrow high
 * ranges so colors stay vivid.
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
 * Resolve a label id to rgba (0..255). Id 0 is transparent; an id in
 * `explicit` (OME `image-label.colors`) gets its declared RGB; any other
 * id gets {@link glasbeyRgb}. Alpha is always 255: some writers declare
 * partial alpha, and honoring it per id leaves a patchwork the layer
 * opacity can't fix.
 *
 * `0xFFFFFFFF` is also the renderer's no-data sentinel. The shader drops
 * it before coloring, so only direct calls reach here with it.
 */
export function labelColor(
  value: number,
  explicit?: ReadonlyMap<number, RGBA>,
): RGBA {
  if (value === 0) return [0, 0, 0, 0];
  if (explicit) {
    const declared = explicit.get(value);
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
 * `r | g<<8 | b<<16 | a<<24`, with alpha forced to 255 as in {@link labelColor}.
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
    // Alpha forced to 255; see the doc comment.
    out[2 * i + 1] =
      ((rgba[0] & 0xff) |
        ((rgba[1] & 0xff) << 8) |
        ((rgba[2] & 0xff) << 16) |
        (0xff << 24)) >>> 0;
  }
  return out;
}
