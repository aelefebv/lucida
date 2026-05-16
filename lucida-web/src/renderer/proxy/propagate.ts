/**
 * Well → fields proxy-handle fan-out.
 *
 * When a `WellProxy3D` upload lands for a well, every field-mode entity
 * descended from that well needs its `wellProxyHandle` updated so the
 * shader can fall back to the parent's proxy when the field's own detail
 * chunks (and its `FieldProxy3D`, if any) haven't been delivered yet.
 *
 * Extracted from `gpu.worker.ts:handleProxyAssetData` (Slice 5).
 */

import type { ProxyHandle } from "../proxyAtlas.ts";
import type { EntityProxyDescriptor } from "../workerContext.ts";

/**
 * Propagate a `WellProxy3D` handle to every child field's descriptor.
 *
 * Pure mutation over the passed Maps — no GPU work, no side effects
 * besides writing into `proxyDescriptorsByEntity`. The well's own
 * descriptor is not touched here; the caller sets that before calling
 * (since this helper only knows about the children).
 */
export function propagateWellProxyToFields(
  handle: ProxyHandle,
  wellId: string,
  wellToFields: Map<string, Set<string>>,
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>,
): void {
  const childFields = wellToFields.get(wellId);
  if (!childFields) return;
  for (const fid of childFields) {
    let desc = proxyDescriptorsByEntity.get(fid);
    if (!desc) {
      desc = { fieldProxyHandle: null, wellProxyHandle: null };
      proxyDescriptorsByEntity.set(fid, desc);
    }
    desc.wellProxyHandle = handle;
  }
}
