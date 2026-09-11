/**
 * A renderer exists before its pipelines do.
 *
 * Every renderer creates its pipelines with `createRenderPipelineAsync`, so
 * the shader compile runs on a GPU-process worker thread instead of the GPU
 * process's main thread. Created synchronously, the bootstrap compile held
 * that thread for about 460 ms on a cold shader cache. The page's first 2D
 * canvas draw creates its GPU context through the same thread, so the page's
 * main thread blocked behind the compile for 640 to 710 ms (#1101).
 *
 * The cost is a window between construction and the first draw. Each
 * renderer exposes `compiled`, which resolves once every one of its pipelines
 * has, and `isCompiled`, the same fact without a wait. A frame handler awaits
 * `compiled` before it draws, and the worker runs one message at a time, so
 * the wait holds the messages behind it in order (`worker/inOrder.ts`). A
 * draw that reaches a pipeline before then is a bug in the caller, and
 * {@link requireCompiled} names it instead of handing WebGPU a null.
 */

/** The pipeline to draw with, or an error naming the renderer that drew too early. */
export function requireCompiled<T>(pipeline: T | null, renderer: string): T {
  if (pipeline === null) throw new Error(`the ${renderer} drew before its pipelines compiled`);
  return pipeline;
}
