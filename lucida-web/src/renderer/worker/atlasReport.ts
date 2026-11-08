/**
 * The worker's atlas residency, measured from the live pools and posted to the
 * page when it changes.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { GpuAtlasReport } from "../workerProtocol.ts";
import type { RendererState } from "./state.ts";

/** Bytes a texture allocates. Every atlas is `r16uint` intensity or `r32uint` label ids. */
function textureBytes(texture: GPUTexture): number {
  const texel = texture.format === "r32uint" ? 4 : 2;
  return texture.width * texture.height * texture.depthOrArrayLayers * texel;
}

/** Count the live chunk and label atlases and the bytes they hold. */
export function measureGpuAtlases(state: RendererState): GpuAtlasReport {
  let atlases = 0;
  let bytes = 0;
  const add = (texture: GPUTexture, indirection: GPUBuffer): void => {
    atlases++;
    bytes += textureBytes(texture) + indirection.size;
  };
  for (const pool of state.volumeAtlases.values()) add(pool.texture, pool.indirectionBuf);
  for (const pool of state.sliceAtlases.values()) add(pool.texture, pool.indirectionBuf);
  for (const pool of state.labelVolumePools.values()) add(pool.texture, pool.indirectionBuf);
  for (const pool of state.labelSlicePools.values()) add(pool.texture, pool.indirectionBuf);
  return { atlases, bytes };
}

/**
 * Post the atlas report when either number differs from the last one posted.
 * The dispatcher checks after cold states, removals, and frames rather than
 * after each upload: an upload that grows or creates a pool always leads to a
 * frame.
 */
export function postGpuAtlasesIfChanged(ctx: WorkerCtx): void {
  const report = measureGpuAtlases(ctx.state);
  const last = ctx.state.gpuAtlasesPosted;
  if (last.atlases === report.atlases && last.bytes === report.bytes) return;
  ctx.state.gpuAtlasesPosted = report;
  ctx.post({ type: "gpuAtlases", ...report });
}
