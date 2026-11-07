import init from "lucida-core";

/**
 * Single-instantiation gate for the wasm module. The bindings' `init()`
 * dedupes only completed initializations: two concurrent calls each
 * instantiate, and the second rebinds exports and memory out from under
 * objects built against the first, which then fault (`unreachable`, then
 * borrow poisoning). StrictMode double-mounts make this routine in dev.
 *
 * Nothing should call the bindings' `init()` directly, and no wasm object may
 * be constructed before the promise returned here resolves.
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
