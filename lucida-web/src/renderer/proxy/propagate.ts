/**
 * Group → tiles proxy-handle fan-out. Every tile under a group carries the
 * group's `groupProxyHandle`, so the shader can fall back to the parent's
 * proxy before the tile's own chunks or `TileProxy3D` arrive.
 */

import type { ProxyHandle } from "../proxyAtlas.ts";
import {
  proxyDescriptorKey,
  type EntityProxyDescriptor,
} from "../workerContext.ts";

/** Propagate a `GroupProxy3D` handle to every child tile's descriptor. The caller sets the group's own. */
export function propagateGroupProxyToTiles(
  handle: ProxyHandle,
  groupId: string,
  t: number,
  c: number,
  groupToTiles: Map<string, Set<string>>,
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>,
): void {
  const childTiles = groupToTiles.get(groupId);
  if (!childTiles) return;
  for (const fid of childTiles) {
    const key = proxyDescriptorKey(fid, t, c);
    let desc = proxyDescriptorsByEntity.get(key);
    if (!desc) {
      desc = { tileProxyHandle: null, groupProxyHandle: null };
      proxyDescriptorsByEntity.set(key, desc);
    }
    desc.groupProxyHandle = handle;
  }
}
