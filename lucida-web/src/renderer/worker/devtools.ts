/**
 * Worker-side devtools / HITL globals.
 *
 * Attaches `self.__lucidaProxyStats`, `self.__lucidaProxyPools`, and
 * `self.__lucidaProxyDescriptors` so a DevTools breakpoint inside the
 * worker thread can inspect current proxy counts + pool + descriptor
 * state without threading through the dispatcher.
 *
 * Extracted from `gpu.worker.ts` in Slice 9 so the entry point doesn't
 * have to know about the debug-surface contract.
 */

import type { RendererState } from "./state.ts";

/**
 * Install the worker-side debug surfaces. Pointers go through the
 * passed {@link RendererState} so a breakpoint sees current values
 * rather than a stale pre-init pointer.
 */
export function installDevtools(state: RendererState): void {
  const target = self as unknown as {
    __lucidaProxyStats?: typeof state.proxyStats;
    __lucidaProxyPools?: typeof state.proxyPoolsByDataset;
    __lucidaProxyDescriptors?: typeof state.proxyDescriptorsByEntity;
  };
  target.__lucidaProxyStats = state.proxyStats;
  target.__lucidaProxyPools = state.proxyPoolsByDataset;
  target.__lucidaProxyDescriptors = state.proxyDescriptorsByEntity;
}
