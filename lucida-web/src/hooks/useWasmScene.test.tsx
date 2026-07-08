// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";

// Double for the generated wasm bindings, faithful to their init contract:
// a COMPLETED initialization is deduped (the module-level handle is set at
// finalize time and returned early), but concurrent IN-FLIGHT calls each
// fetch + instantiate, and every finalize reassigns the module-level handle
// — so any extra instantiation strands objects built against the previous
// instance on stale memory. The assertions below therefore pin the number
// of *instantiations*, not the number of `init()` calls.
const glue = vi.hoisted(() => ({
  instantiations: 0,
  finalized: undefined as object | undefined,
  pending: [] as Array<{ finalize: () => void; fail: (err: Error) => void }>,
  reset() {
    this.instantiations = 0;
    this.finalized = undefined;
    this.pending = [];
  },
  /** Complete every in-flight instantiation (last finalize wins, as in the
   *  generated glue). */
  finalizeAll() {
    for (const p of this.pending.splice(0)) p.finalize();
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
  WasmScene: class {
    constructor(_w?: number, _h?: number) {}
  },
  set_debug_categories: vi.fn(),
}));

/** Fresh module state (the init cache is module-level) per test. */
async function loadHook() {
  vi.resetModules();
  return await import("./useWasmScene.ts");
}

beforeEach(() => {
  glue.reset();
});

describe("useWasmScene wasm boot", () => {
  it("a dev double-mount (StrictMode) performs exactly one wasm instantiation", async () => {
    const { useWasmScene } = await loadHook();

    // StrictMode runs the boot effect twice (mount → cleanup → mount) while
    // the first initialization is still in flight; both runs must share it.
    const { result } = renderHook(() => useWasmScene(), { wrapper: StrictMode });
    expect(glue.instantiations).toBe(1);

    glue.finalizeAll();
    await waitFor(() => expect(result.current.wasmReady).toBe(true));
    expect(glue.instantiations).toBe(1);
  });

  it("a remount after a completed initialization does not re-instantiate", async () => {
    const { useWasmScene } = await loadHook();

    const first = renderHook(() => useWasmScene());
    glue.finalizeAll();
    await waitFor(() => expect(first.result.current.wasmReady).toBe(true));
    first.unmount();

    const second = renderHook(() => useWasmScene());
    await waitFor(() => expect(second.result.current.wasmReady).toBe(true));
    expect(glue.instantiations).toBe(1);
  });

  it("two hosts booting concurrently share one instantiation and both become ready", async () => {
    const { useWasmScene } = await loadHook();

    const a = renderHook(() => useWasmScene());
    const b = renderHook(() => useWasmScene());
    expect(glue.instantiations).toBe(1);

    glue.finalizeAll();
    await waitFor(() => expect(a.result.current.wasmReady).toBe(true));
    await waitFor(() => expect(b.result.current.wasmReady).toBe(true));
    expect(glue.instantiations).toBe(1);
  });
});
