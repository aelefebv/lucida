/** WebGPU render worker — thin entry point that delegates to `worker/`. */
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { bootstrapWorker } from "./worker/bootstrap.ts";
import { dispatchMessage } from "./worker/dispatch.ts";
import { installDevtools } from "./worker/devtools.ts";
import { handleDestroy } from "./worker/lifecycle.ts";

let ctx: WorkerCtx | null = null;

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg);
}

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      ctx = await bootstrapWorker(msg.canvas, post);
      installDevtools(ctx.state);
      post({ type: "ready" });
      return;
    }
    if (!ctx) return; // ignore messages before init completes
    if (msg.type === "destroy") {
      handleDestroy(ctx);
      ctx = null;
      return;
    }
    await dispatchMessage(ctx, msg);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
