/** WebGPU render worker entry point; the handlers live in `worker/`. */
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { bootstrapWorker } from "./worker/bootstrap.ts";
import { dispatchMessage } from "./worker/dispatch.ts";
import { handleDestroy } from "./worker/lifecycle.ts";
import { inOrder } from "./worker/inOrder.ts";
import { reportWorkerErrors } from "../pageErrors.ts";

reportWorkerErrors();

let ctx: WorkerCtx | null = null;

// `self` is typed as `Window` here (the app tsconfig's lib has DOM but not
// WebWorker), whose `postMessage` overloads don't include the
// `(message, transfer[])` form the dedicated-worker scope provides at runtime.
// Narrow to just the shape we use so the transfer-list call type-checks.
const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

function post(msg: WorkerToMainMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    workerScope.postMessage(msg, transfer);
  } else {
    workerScope.postMessage(msg);
  }
}

function postError(err: unknown): void {
  post({ type: "error", message: err instanceof Error ? err.message : String(err) });
}

async function handleMessage(msg: MainToWorkerMessage): Promise<void> {
  try {
    if (msg.type === "init") {
      ctx = await bootstrapWorker(msg.canvas, post, msg.deviceMemoryGiB ?? null, (task) => enqueue(task));
      post({ type: "ready" });
      return;
    }
    if (!ctx) return; // init failed or never ran: nothing to run it against
    if (msg.type === "destroy") {
      handleDestroy(ctx);
      ctx = null;
      return;
    }
    await dispatchMessage(ctx, msg);
  } catch (err) {
    postError(err);
  }
}

// The main thread relies on the worker handling messages in arrival order
// (`worker/inOrder.ts`). A frame's wait for its pipelines must not break it,
// and replacing a lost device takes its turn in the same order.
const enqueue = inOrder((task: () => Promise<void>) => task(), postError);
self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
  enqueue(() => handleMessage(e.data));
};
