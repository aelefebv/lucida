/**
 * Worker-process GPU resource caches: LUT texture cache, offscreen
 * target pool, and 1×1 / 1×1×1 dummy textures bound when no real
 * texture is available.
 *
 * Module-scoped (not on {@link RendererState}) because they belong to
 * the worker process itself — per-device, not per-session.
 * `RendererState` is for per-session/per-dataset state that resets on
 * `destroy`.
 *
 * Per-renderer dummies (`dummyTexture` / `dummyIndirectionBuffer` /
 * `dummyProxyTexture` inside `SliceRenderer` and `VolumeRenderer`) and
 * per-atlas dummies (`dummyIndirectionBuf` in `volume/atlas.ts`,
 * `dummySliceIndirectionBuf` in `slice/atlas.ts`) stay where they are —
 * they're tightly coupled to bind-group construction and atlas-pool
 * lifecycle in those modules.
 */

import { createOffscreenTarget } from "../gpuContext.ts";
import { getColormapData } from "../../colormaps.ts";

// ── LUT texture cache (per-device, lazy on first colormap use) ─────────
const lutCache = new Map<string, GPUTexture>();

/** Get or create the 256×1 rgba8unorm LUT texture for a colormap name. */
export function getOrCreateLUT(device: GPUDevice, name: string): GPUTexture {
  let tex = lutCache.get(name);
  if (tex) return tex;
  const data = getColormapData(name);
  tex = device.createTexture({
    size: [256, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app).
  device.queue.writeTexture({ texture: tex }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: 256 * 4 }, [256, 1]);
  lutCache.set(name, tex);
  return tex;
}

// ── Label LUT texture cache (per-device, keyed by `${datasetId}:${labelIndex}`) ─
//
// A label's indexed-colour LUT holds 65536 rgba8 entries built ONCE from the
// `rgba` bytes the cold state delivers (`WasmScene::label_lut(...).rgba`, a flat
// row-major 65536×4 array). The web never decodes `ImageRole`/`LabelColor` — it
// uploads the bytes verbatim. The label member's shader branch reads this via
// `textureLoad` at the exact (masked) id, so it's bound with no sampler.
//
// Shape: a **256×256** rgba8unorm texture, NOT 65536×1. 65536 exceeds
// `maxTextureDimension2D` (8192–16384 on real devices) so a 65536-wide texture
// is INVALID on real GPUs — `createTexture` fails validation, the texture is
// dropped, and the label draw silently renders nothing. 256×256 is the same
// 65536 texels / same bytes, well under the limit. Because the source is flat
// row-major, uploading it row-major lands texel value `i` at
// `(x = i & 255, y = i >> 8)`; the shader indexes it with that same 2D mapping.
const labelLutCache = new Map<string, GPUTexture>();

/** Expected byte length of a full label LUT (`CAP=65536` entries × rgba8). */
const LABEL_LUT_BYTES = 65536 * 4;

/**
 * Side length of the square label LUT texture (256 → 256×256 = 65536 texels).
 * Chosen so both dimensions stay far below `maxTextureDimension2D`.
 */
const LABEL_LUT_DIM = 256;

/**
 * (Re)build and cache the 256×256 rgba8unorm label LUT texture for `key` from
 * raw `rgba8` bytes (a flat row-major 65536×4 array). Idempotent per `key`: a
 * second call with the same key replaces the texture (used when a label's
 * palette changes). Throws if the byte length isn't the full LUT — a short
 * buffer would silently mis-colour.
 *
 * The flat source is uploaded row-major into the square texture, so entry `i`
 * lands at `(x = i & 255, y = i >> 8)` — the mapping the shader inverts.
 */
export function setLabelLUT(device: GPUDevice, key: string, rgba: Uint8Array): GPUTexture {
  if (rgba.length !== LABEL_LUT_BYTES) {
    throw new Error(
      `setLabelLUT[${key}]: expected ${LABEL_LUT_BYTES} rgba bytes (65536×4), got ${rgba.length}`,
    );
  }
  const existing = labelLutCache.get(key);
  if (existing) existing.destroy();
  const tex = device.createTexture({
    size: [LABEL_LUT_DIM, LABEL_LUT_DIM],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // 256 * 4 = 1024 bytes/row, already a multiple of 256 → no padding. The flat
  // row-major source maps directly onto the 256×256 rows (row y = bytes
  // y*1024..(y+1)*1024), so entry i sits at (i & 255, i >> 8).
  device.queue.writeTexture(
    { texture: tex },
    rgba as Uint8Array<ArrayBuffer>,
    { bytesPerRow: LABEL_LUT_DIM * 4 },
    [LABEL_LUT_DIM, LABEL_LUT_DIM],
  );
  labelLutCache.set(key, tex);
  return tex;
}

/** The cached label LUT texture for `key`, or `null` if none built yet. */
export function getLabelLUT(key: string): GPUTexture | null {
  return labelLutCache.get(key) ?? null;
}

/**
 * Drop cached label LUT textures for a dataset (keys `${datasetId}:*`). Called
 * from `removeLayerResources` so a dropped dataset's LUTs don't leak.
 */
export function removeLabelLUTsForDataset(datasetId: string): void {
  const prefix = `${datasetId}:`;
  for (const [key, tex] of labelLutCache) {
    if (key.startsWith(prefix)) {
      tex.destroy();
      labelLutCache.delete(key);
    }
  }
}

// ── Shared offscreen target pool (resized when canvas dims change) ─────
let offscreenPool: GPUTexture[] = [];
let poolWidth = 0;
let poolHeight = 0;

/**
 * Ensure the shared offscreen render-target pool has at least `count`
 * textures sized w×h. Resizes the pool if canvas dims changed (destroys
 * existing textures), then grows it as needed.
 */
export function ensureOffscreenPool(device: GPUDevice, count: number, w: number, h: number): GPUTexture[] {
  if (w !== poolWidth || h !== poolHeight) {
    for (const tex of offscreenPool) tex.destroy();
    offscreenPool = [];
    poolWidth = w;
    poolHeight = h;
  }
  while (offscreenPool.length < count) {
    offscreenPool.push(createOffscreenTarget(device, w, h));
  }
  return offscreenPool;
}

// ── 1×1 dummy 2D texture (r16uint, bound for unset 2D bindings) ────────
let dummyTexture: GPUTexture | null = null;

/** Get or lazily allocate the 1×1 r16uint dummy 2D texture. */
export function getDummyTexture(device: GPUDevice): GPUTexture {
  if (!dummyTexture) {
    dummyTexture = device.createTexture({
      size: [1, 1],
      format: "r16uint",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  return dummyTexture;
}

// ── 1×1×1 dummy 3D texture (r16uint, bound for unset 3D bindings) ─────
let dummy3DTexture: GPUTexture | null = null;

/** Get or lazily allocate the 1×1×1 r16uint dummy 3D texture. */
export function getDummy3DTexture(device: GPUDevice): GPUTexture {
  if (!dummy3DTexture) {
    dummy3DTexture = device.createTexture({
      size: [1, 1, 1],
      format: "r16uint",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  return dummy3DTexture;
}

/**
 * Tear down every cached worker-process GPU resource. Called from the
 * `destroy` handler before `self.close()`. Per-renderer / per-atlas
 * dummies are torn down by their owning modules.
 */
export function destroyAllResources(): void {
  for (const tex of offscreenPool) tex.destroy();
  offscreenPool = [];
  poolWidth = 0;
  poolHeight = 0;
  for (const tex of lutCache.values()) tex.destroy();
  lutCache.clear();
  for (const tex of labelLutCache.values()) tex.destroy();
  labelLutCache.clear();
  dummyTexture?.destroy();
  dummyTexture = null;
  dummy3DTexture?.destroy();
  dummy3DTexture = null;
}
