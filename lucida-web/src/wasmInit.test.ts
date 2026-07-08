import { describe, it, expect, vi, beforeEach } from "vitest";

// Double for the generated bindings' `init()`: dedupes COMPLETED
// initializations only — concurrent in-flight calls each instantiate, which
// is exactly the hazard `initWasmOnce` exists to close.
const glue = vi.hoisted(() => ({
  instantiations: 0,
  finalized: undefined as object | undefined,
  pending: [] as Array<{ finalize: () => void; fail: (err: Error) => void }>,
  reset() {
    this.instantiations = 0;
    this.finalized = undefined;
    this.pending = [];
  },
  finalizeAll() {
    for (const p of this.pending.splice(0)) p.finalize();
  },
  failAll(err: Error) {
    for (const p of this.pending.splice(0)) p.fail(err);
  },
}));

vi.mock("lucida-core", () => ({
  default: () => {
    if (glue.finalized !== undefined) return Promise.resolve(glue.finalized);
    glue.instantiations += 1;
    const instance = { id: glue.instantiations };
    return new Promise((resolve, reject) => {
      glue.pending.push({
        finalize: () => {
          glue.finalized = instance;
          resolve(instance);
        },
        fail: reject,
      });
    });
  },
}));

/** Fresh module state (the init cache is module-level) per test. */
async function loadModule() {
  vi.resetModules();
  return await import("./wasmInit.ts");
}

beforeEach(() => {
  glue.reset();
});

describe("initWasmOnce", () => {
  it("concurrent callers share one in-flight instantiation", async () => {
    const { initWasmOnce } = await loadModule();

    const a = initWasmOnce();
    const b = initWasmOnce();
    expect(glue.instantiations).toBe(1);

    glue.finalizeAll();
    await Promise.all([a, b]);

    // Later callers ride the settled promise — still one instantiation.
    await initWasmOnce();
    expect(glue.instantiations).toBe(1);
  });

  it("a failed initialization propagates to all waiters and allows a retry", async () => {
    const { initWasmOnce } = await loadModule();

    const a = initWasmOnce();
    const b = initWasmOnce();
    // Attach rejection handlers before failing so neither surfaces as an
    // unhandled rejection.
    const aErr = a.catch((e: unknown) => e);
    const bErr = b.catch((e: unknown) => e);
    glue.failAll(new Error("fetch failed"));
    expect(await aErr).toEqual(new Error("fetch failed"));
    expect(await bErr).toEqual(new Error("fetch failed"));

    // A failed load leaves the bindings uninitialized, so a later caller
    // must get a fresh attempt rather than the pinned rejection.
    const retry = initWasmOnce();
    expect(glue.instantiations).toBe(2);
    glue.finalizeAll();
    await retry;
  });
});
