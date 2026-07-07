/**
 * Group → tiles proxy-handle fan-out.
 *
 * When a `GroupProxy3D` upload lands for a group, every tile-mode entity
 * descended from that group needs its `groupProxyHandle` updated so the
 * shader can fall back to the parent's proxy when the tile's own
 * detail chunks (and its `TileProxy3D`, if any) haven't arrived.
 */

import type { ProxyHandle } from "../proxyAtlas.ts";
import {
  proxyDescriptorKey,
  type EntityProxyDescriptor,
} from "../workerContext.ts";

/**
 * Propagate a `GroupProxy3D` handle to every child tile's descriptor.
 *
 * Pure mutation over the passed Maps — no GPU work, no side effects
 * besides writing into `proxyDescriptorsByEntity`. The group's own
 * descriptor is not touched here; the caller sets that before calling
 * (since this helper only knows about the children).
 */
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
