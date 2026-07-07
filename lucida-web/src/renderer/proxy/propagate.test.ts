/**
 * Tests for `propagateGroupProxyToTiles`. Pure Map mutation — no GPU.
 *
 * Locks the behavior the inline `handleProxyAssetData` branch provided:
 *   - group with no children → no-op
 *   - group with one child → child gets handle
 *   - group with multiple children → all children get same handle
 *   - children with pre-existing descriptors get `groupProxyHandle`
 *     overwritten (other handles preserved)
 *   - missing child descriptor is created with `tileProxyHandle: null`
 */

import { describe, it, expect } from "vitest";
import { propagateGroupProxyToTiles } from "./propagate.ts";
import type { ProxyHandle } from "../proxyAtlas.ts";
import {
  proxyDescriptorKey,
  type EntityProxyDescriptor,
} from "../workerContext.ts";

const handle: ProxyHandle = { poolKey: "ds1|proxy|GroupProxy3D|64x64x32|ch0", slotIndex: 3 };
const t = 2;
const c = 0;

describe("propagateGroupProxyToTiles", () => {
  it("group with no children → no-op (no descriptor entries written)", () => {
    const groupToTiles = new Map<string, Set<string>>();
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateGroupProxyToTiles(handle, "groupA", t, c, groupToTiles, descriptors);
    expect(descriptors.size).toBe(0);
  });

  it("group with one child → child descriptor gets groupProxyHandle", () => {
    const groupToTiles = new Map<string, Set<string>>([["groupA", new Set(["tileA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateGroupProxyToTiles(handle, "groupA", t, c, groupToTiles, descriptors);
    const desc = descriptors.get(proxyDescriptorKey("tileA", t, c));
    expect(desc).toBeDefined();
    expect(desc!.groupProxyHandle).toBe(handle);
    expect(desc!.tileProxyHandle).toBeNull();
  });

  it("group with multiple children → all child descriptors point at same handle", () => {
    const groupToTiles = new Map<string, Set<string>>([
      ["groupA", new Set(["tileA", "tileB", "tileC"])],
    ]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateGroupProxyToTiles(handle, "groupA", t, c, groupToTiles, descriptors);
    expect(descriptors.get(proxyDescriptorKey("tileA", t, c))!.groupProxyHandle).toBe(handle);
    expect(descriptors.get(proxyDescriptorKey("tileB", t, c))!.groupProxyHandle).toBe(handle);
    expect(descriptors.get(proxyDescriptorKey("tileC", t, c))!.groupProxyHandle).toBe(handle);
    // Same handle reference (we don't copy).
    expect(descriptors.get(proxyDescriptorKey("tileA", t, c))!.groupProxyHandle).toBe(
      descriptors.get(proxyDescriptorKey("tileB", t, c))!.groupProxyHandle,
    );
  });

  it("pre-existing tile descriptor → groupProxyHandle overwritten, tileProxyHandle preserved", () => {
    const existingTileHandle: ProxyHandle = { poolKey: "ds1|proxy|TileProxy3D|32x32x16|ch0", slotIndex: 7 };
    const groupToTiles = new Map<string, Set<string>>([["groupA", new Set(["tileA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("tileA", t, c), { tileProxyHandle: existingTileHandle, groupProxyHandle: null }],
    ]);
    propagateGroupProxyToTiles(handle, "groupA", t, c, groupToTiles, descriptors);
    const desc = descriptors.get(proxyDescriptorKey("tileA", t, c))!;
    expect(desc.groupProxyHandle).toBe(handle);
    expect(desc.tileProxyHandle).toBe(existingTileHandle);
  });

  it("missing group in groupToTiles → no-op", () => {
    const groupToTiles = new Map<string, Set<string>>([["groupA", new Set(["tileA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateGroupProxyToTiles(handle, "groupMissing", t, c, groupToTiles, descriptors);
    expect(descriptors.size).toBe(0);
  });
});
