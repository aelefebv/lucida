/**
 * Worker-process GPU resource caches: LUT texture cache and offscreen
 * target pool.
 *
 * Module-scoped (not on {@link RendererState}) because they belong to
 * the worker process itself — per-device, not per-session.
 * `RendererState` is for per-session/per-dataset state that resets on
 * `destroy`.
 *
 * The dummy textures and sentinel indirection buffers bound to unused
 * pool slots live inside `SliceRenderer` and `VolumeRenderer`, next to
 * the bind-group construction that needs them.
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

/**
 * Tear down every cached worker-process GPU resource. Called from the
 * `destroy` handler before `self.close()`. Per-renderer dummies are torn
 * down by their owning modules.
 */
export function destroyAllResources(): void {
  for (const tex of offscreenPool) tex.destroy();
  offscreenPool = [];
  poolWidth = 0;
  poolHeight = 0;
  for (const tex of lutCache.values()) tex.destroy();
  lutCache.clear();
}
