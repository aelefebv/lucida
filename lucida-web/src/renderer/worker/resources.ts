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
 * Per-renderer dummies (`dummyTexture` / `dummyIndirectionBuffer`) and
 * per-atlas dummies (`dummyIndirectionBuf` in `volume/atlas.ts`,
 * `dummySliceIndirectionBuf` in `slice/atlas.ts`) stay where they are —
 * they're tightly coupled to bind-group construction and atlas-pool
 * lifecycle in those modules.
 */

import { getDeviceLimits, OFFSCREEN_FORMAT } from "../gpuContext.ts";
import { getColormapData } from "../../colormaps.ts";
import {
  type TrackedGpuResource,
  type GpuResourceBudget,
} from "../gpuResourceBudget.ts";

// ── LUT texture cache (per-device, lazy on first colormap use) ─────────
const lutCache = new Map<string, GPUTexture>();
const lutAllocations = new Map<string, TrackedGpuResource<GPUTexture>>();

/** Get or create the 256×1 rgba8unorm LUT texture for a colormap name. */
export function getOrCreateLUT(
  device: GPUDevice,
  resources: GpuResourceBudget,
  name: string,
): GPUTexture {
  let tex = lutCache.get(name);
  if (tex) return tex;
  const data = getColormapData(name);
  const allocation = resources.createTexture(
    device,
    { key: `session:lut:${name}`, kind: "lookup" },
    {
      size: [256, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    },
  );
  tex = allocation.resource;
  // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app).
  device.queue.writeTexture({ texture: tex }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: 256 * 4 }, [256, 1]);
  lutCache.set(name, tex);
  lutAllocations.set(name, allocation);
  return tex;
}

// ── Shared offscreen target pool (resized when canvas dims change) ─────
let offscreenPool: GPUTexture[] = [];
let offscreenAllocations: TrackedGpuResource<GPUTexture>[] = [];
let poolWidth = 0;
let poolHeight = 0;

/** Slice and volume compositing are incremental, so one reusable target is enough. */
export const MAX_SHARED_OFFSCREEN_TARGETS = 1;

/**
 * Ensure the shared offscreen render-target pool has at least `count`
 * textures sized w×h. Resizes the pool if canvas dims changed (destroys
 * existing textures), then grows it as needed.
 */
export function ensureOffscreenPool(
  device: GPUDevice,
  resources: GpuResourceBudget,
  count: number,
  w: number,
  h: number,
): GPUTexture[] {
  if (count < 0 || count > MAX_SHARED_OFFSCREEN_TARGETS) {
    throw new Error(
      `offscreen target request ${count} exceeds bounded pool size ` +
        `${MAX_SHARED_OFFSCREEN_TARGETS}`,
    );
  }
  const limit = getDeviceLimits(device).maxTextureDimension2D;
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w > limit || h > limit) {
    throw new Error(`invalid offscreen target dimensions ${w}x${h} (device limit ${limit})`);
  }
  if (w !== poolWidth || h !== poolHeight) {
    for (const allocation of offscreenAllocations) allocation.destroy();
    offscreenPool = [];
    offscreenAllocations = [];
    poolWidth = w;
    poolHeight = h;
  }
  while (offscreenPool.length < count) {
    const index = offscreenPool.length;
    // rgba16float = 8 bytes/pixel. The actual texture may have driver padding,
    // but this is the portable WebGPU payload footprint we can account for.
    const allocation = resources.createTexture(
      device,
      { key: `session:offscreen:${index}`, kind: "offscreen" },
      {
        size: [w, h],
        format: OFFSCREEN_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      },
    );
    offscreenAllocations.push(allocation);
    offscreenPool.push(allocation.resource);
  }
  return offscreenPool;
}

// ── 1×1 dummy 2D texture (r16uint, bound for unset 2D bindings) ────────
let dummyTexture: GPUTexture | null = null;
let dummyTextureAllocation: TrackedGpuResource<GPUTexture> | null = null;

/** Get or lazily allocate the 1×1 r16uint dummy 2D texture. */
export function getDummyTexture(device: GPUDevice, resources: GpuResourceBudget): GPUTexture {
  if (!dummyTexture) {
    dummyTextureAllocation = resources.createTexture(
      device,
      { key: "session:dummy-2d", kind: "lookup" },
      {
        size: [1, 1],
        format: "r16uint",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      },
    );
    dummyTexture = dummyTextureAllocation.resource;
  }
  return dummyTexture;
}

// ── 1×1×1 dummy 3D texture (r16uint, bound for unset 3D bindings) ─────
let dummy3DTexture: GPUTexture | null = null;
let dummy3DTextureAllocation: TrackedGpuResource<GPUTexture> | null = null;

/** Get or lazily allocate the 1×1×1 r16uint dummy 3D texture. */
export function getDummy3DTexture(device: GPUDevice, resources: GpuResourceBudget): GPUTexture {
  if (!dummy3DTexture) {
    dummy3DTextureAllocation = resources.createTexture(
      device,
      { key: "session:dummy-3d", kind: "lookup" },
      {
        size: [1, 1, 1],
        format: "r16uint",
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      },
    );
    dummy3DTexture = dummy3DTextureAllocation.resource;
  }
  return dummy3DTexture;
}

/**
 * Tear down every cached worker-process GPU resource. Called from the
 * `destroy` handler before `self.close()`. Per-renderer / per-atlas
 * dummies are torn down by their owning modules.
 */
export function destroyAllResources(): void {
  for (const allocation of offscreenAllocations) allocation.destroy();
  offscreenPool = [];
  offscreenAllocations = [];
  poolWidth = 0;
  poolHeight = 0;
  for (const allocation of lutAllocations.values()) allocation.destroy();
  lutCache.clear();
  lutAllocations.clear();
  dummyTextureAllocation?.destroy();
  dummyTextureAllocation = null;
  dummyTexture = null;
  dummy3DTextureAllocation?.destroy();
  dummy3DTextureAllocation = null;
  dummy3DTexture = null;
}
