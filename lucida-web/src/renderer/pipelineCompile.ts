/**
 * A renderer exists before its pipelines do.
 *
 * Pipelines come from `createRenderPipelineAsync`, so the shader compile runs
 * off the GPU process's main thread. A synchronous compile holds that thread
 * for hundreds of milliseconds on a cold shader cache, and the page's first
 * 2D canvas draw waits behind it. Frame handlers await each renderer's
 * `compiled` in message order (`worker/inOrder.ts`); {@link requireCompiled}
 * names a draw that comes too early instead of handing WebGPU a null.
 */

/** The pipeline to draw with, or an error naming the renderer that drew too early. */
export function requireCompiled<T>(pipeline: T | null, renderer: string): T {
  if (pipeline === null) throw new Error(`the ${renderer} drew before its pipelines compiled`);
  return pipeline;
}
