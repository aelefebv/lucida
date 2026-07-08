import init from "lucida-core";

/**
 * Single-instantiation gate for the wasm module.
 *
 * The generated bindings' `init()` dedupes only COMPLETED initializations:
 * two concurrent calls each fetch and instantiate the module, and the second
 * finalize silently rebinds the module-level exports and memory views out
 * from under anything constructed against the first instance — after which
 * every call into such an object faults (`RuntimeError: unreachable`, then
 * permanent borrow-poisoning errors on the whole scene pipeline). Concurrent
 * boots are routine in dev, where React StrictMode double-mounts the app.
 *
 * This cache shares one in-flight (or settled) initialization promise, so a
 * page performs exactly one instantiation no matter how many hosts boot
 * concurrently or how often they remount. Nothing should call the bindings'
 * `init()` directly, and no wasm object (e.g. `WasmScene`) may be
 * constructed before the promise returned here resolves.
 */
let wasmInit: Promise<void> | null = null;

/**
 * Initialize the wasm module exactly once per page load. Concurrent and
 * repeated callers share the same initialization; a rejected attempt clears
 * the cache (a failed load leaves the bindings uninitialized, so retrying
 * is safe) rather than pinning every future caller to the rejection.
 */
export function initWasmOnce(): Promise<void> {
  if (!wasmInit) {
    const attempt = init().then(
      () => undefined,
      (err: unknown) => {
        if (wasmInit === attempt) wasmInit = null;
        throw err;
      },
    );
    wasmInit = attempt;
  }
  return wasmInit;
}
