import { afterEach, describe, expect, it, vi } from "vitest";

import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";

// The entry point is where the message order is decided, and the main
// thread's recorder relies on that order (`worker/inOrder.ts`). The test
// replaces everything behind it and reads the composition alone.
const seen = vi.hoisted(() => ({
  log: [] as string[],
  gate: null as Promise<void> | null,
}));

vi.mock("./worker/bootstrap.ts", () => ({
  bootstrapWorker: vi.fn(async () => ({ state: {} })),
}));
vi.mock("./worker/devtools.ts", () => ({ installDevtools: vi.fn() }));
vi.mock("./worker/lifecycle.ts", () => ({ handleDestroy: vi.fn() }));
vi.mock("./worker/dispatch.ts", () => ({
  dispatchMessage: vi.fn(async (_ctx: unknown, msg: MainToWorkerMessage) => {
    seen.log.push(`start ${msg.type}`);
    if (msg.type === "sliceRenderMultiPass" && seen.gate) await seen.gate;
    seen.log.push(`end ${msg.type}`);
  }),
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the render worker's entry point", () => {
  it("runs messages one at a time, so a frame's wait holds the messages behind it", async () => {
    const posted: WorkerToMainMessage[] = [];
    const scope = {
      postMessage: (msg: WorkerToMainMessage) => {
        posted.push(msg);
      },
      onmessage: null as ((e: MessageEvent<MainToWorkerMessage>) => void) | null,
    };
    vi.stubGlobal("self", scope);
    await import("./gpu.worker.ts");
    const receive = (msg: MainToWorkerMessage) => {
      scope.onmessage!({ data: msg } as MessageEvent<MainToWorkerMessage>);
    };

    let finish!: () => void;
    seen.gate = new Promise<void>((resolve) => {
      finish = resolve;
    });

    receive({ type: "init", canvas: {} as OffscreenCanvas });
    receive({ type: "sliceRenderMultiPass" } as unknown as MainToWorkerMessage);
    receive({ type: "resize", width: 8, height: 8 });
    await flush();
    expect(posted).toEqual([{ type: "ready" }]);
    expect(seen.log).toEqual(["start sliceRenderMultiPass"]);

    finish();
    await flush();
    expect(seen.log).toEqual([
      "start sliceRenderMultiPass",
      "end sliceRenderMultiPass",
      "start resize",
      "end resize",
    ]);
  });
});
