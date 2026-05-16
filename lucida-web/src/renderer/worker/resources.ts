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
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app). See #438.
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
  dummyTexture?.destroy();
  dummyTexture = null;
  dummy3DTexture?.destroy();
  dummy3DTexture = null;
}
