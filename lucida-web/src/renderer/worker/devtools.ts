/**
 * Worker-side devtools globals, so a DevTools breakpoint in the worker can
 * inspect proxy stats, pools, and descriptors.
 */

import type { RendererState } from "./state.ts";

/** Install the worker-side debug globals, pointing at live {@link RendererState} maps. */
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
