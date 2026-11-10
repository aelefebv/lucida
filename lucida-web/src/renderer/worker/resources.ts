/**
 * Worker-process GPU resource caches: the LUT textures. Module-scoped rather
 * than on `RendererState` because they are per-device, not per-session.
 */

import { getColormapData } from "../../colormaps.ts";

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

/** Tear down every cached worker-process GPU resource. Called from the `destroy` handler. */
export function destroyAllResources(): void {
  for (const tex of lutCache.values()) tex.destroy();
  lutCache.clear();
}
