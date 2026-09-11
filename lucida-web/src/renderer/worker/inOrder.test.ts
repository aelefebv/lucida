import { describe, expect, it, vi } from "vitest";

import { inOrder } from "./inOrder.ts";

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every settled promise reaction run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("inOrder", () => {
  it("runs the next message only after the one before it settled", async () => {
    const gate = deferred();
    const log: string[] = [];
    const handle = vi.fn(async (msg: string) => {
      log.push(`start ${msg}`);
      if (msg === "render") await gate.promise;
      log.push(`end ${msg}`);
    });
    const post = inOrder(handle);

    post("render");
    post("chunk");
    post("render-2");
    await flush();

    expect(log).toEqual(["start render"]);

    gate.resolve();
    await flush();
    expect(log).toEqual([
      "start render",
      "end render",
      "start chunk",
      "end chunk",
      "start render-2",
      "end render-2",
    ]);
  });

  it("keeps a synchronous handler's messages in arrival order", async () => {
    const seen: number[] = [];
    const post = inOrder((n: number) => {
      seen.push(n);
    });
    for (let i = 0; i < 5; i++) post(i);
    await flush();
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports a message that throws and still runs the ones behind it", async () => {
    const errors: unknown[] = [];
    const seen: string[] = [];
    const post = inOrder(
      async (msg: string) => {
        if (msg === "bad") throw new Error("refused");
        seen.push(msg);
      },
      (err) => errors.push(err),
    );

    post("first");
    post("bad");
    post("after");
    await flush();

    expect(seen).toEqual(["first", "after"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("refused");
  });

  it("reports a rejected wait the same way", async () => {
    const gate = deferred();
    const errors: unknown[] = [];
    const seen: string[] = [];
    const post = inOrder(
      async (msg: string) => {
        if (msg === "waits") await gate.promise;
        seen.push(msg);
      },
      (err) => errors.push(err),
    );

    post("waits");
    post("next");
    await flush();
    expect(seen).toEqual([]);

    gate.reject(new Error("pipelines failed"));
    await flush();
    expect(seen).toEqual(["next"]);
    expect((errors[0] as Error).message).toBe("pipelines failed");
  });
});
