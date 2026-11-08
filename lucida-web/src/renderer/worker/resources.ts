/**
 * Worker-process GPU resource caches: LUT textures and the offscreen target
 * pool. Module-scoped rather than on `RendererState` because they are
 * per-device, not per-session.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { createOffscreenTarget } from "../gpuContext.ts";
import { getColormapData } from "../../colormaps.ts";
import { allocateWatched } from "./gpuErrors.ts";
import { handleGpuOutOfMemory } from "./gpuBudget.ts";
import { setGpuLedgerLine } from "./gpuLedger.ts";

/** Bytes one `rgba16float` offscreen texel holds. */
export const OFFSCREEN_BYTES_PER_TEXEL = 8;

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

let offscreenPool: GPUTexture[] = [];
let poolWidth = 0;
let poolHeight = 0;

function noteOffscreenBytes(): void {
  setGpuLedgerLine("viewportTargets", offscreenPool.length * poolWidth * poolHeight * OFFSCREEN_BYTES_PER_TEXEL);
}

/**
 * Ensure the offscreen pool holds at least `count` textures sized w×h,
 * rebuilding it when the dims change. A target the device can't allocate
 * leaves the pool, so the next frame makes it again under the halved total.
 */
export function ensureOffscreenPool(ctx: WorkerCtx, count: number, w: number, h: number): GPUTexture[] {
  if (w !== poolWidth || h !== poolHeight) {
    for (const tex of offscreenPool) tex.destroy();
    offscreenPool = [];
    poolWidth = w;
    poolHeight = h;
  }
  while (offscreenPool.length < count) {
    offscreenPool.push(allocateWatched(
      ctx,
      () => createOffscreenTarget(ctx.device, w, h),
      (lost) => {
        const at = offscreenPool.indexOf(lost);
        if (at >= 0) {
          offscreenPool.splice(at, 1);
          lost.destroy();
          noteOffscreenBytes();
        }
        handleGpuOutOfMemory(ctx);
      },
    ));
  }
  noteOffscreenBytes();
  return offscreenPool;
}

/** Free the targets past the first `count`, which the frame just drawn did not use. */
export function trimOffscreenPool(count: number): void {
  if (offscreenPool.length <= count) return;
  for (const tex of offscreenPool.splice(count)) tex.destroy();
  noteOffscreenBytes();
}

/** Tear down every cached worker-process GPU resource. Called from the `destroy` handler. */
export function destroyAllResources(): void {
  for (const tex of offscreenPool) tex.destroy();
  offscreenPool = [];
  poolWidth = 0;
  poolHeight = 0;
  noteOffscreenBytes();
  for (const tex of lutCache.values()) tex.destroy();
  lutCache.clear();
}
