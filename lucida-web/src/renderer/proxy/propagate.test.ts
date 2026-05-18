/**
 * Tests for `propagateWellProxyToFields`. Pure Map mutation — no GPU.
 *
 * Locks the behavior the inline `handleProxyAssetData` branch provided:
 *   - well with no children → no-op
 *   - well with one child → child gets handle
 *   - well with multiple children → all children get same handle
 *   - children with pre-existing descriptors get `wellProxyHandle`
 *     overwritten (other handles preserved)
 *   - missing child descriptor is created with `fieldProxyHandle: null`
 */

import { describe, it, expect } from "vitest";
import { propagateWellProxyToFields } from "./propagate.ts";
import type { ProxyHandle } from "../proxyAtlas.ts";
import {
  proxyDescriptorKey,
  type EntityProxyDescriptor,
} from "../workerContext.ts";

const handle: ProxyHandle = { poolKey: "ds1|proxy|WellProxy3D|64x64x32|ch0", slotIndex: 3 };
const t = 2;
const c = 0;

describe("propagateWellProxyToFields", () => {
  it("well with no children → no-op (no descriptor entries written)", () => {
    const wellToFields = new Map<string, Set<string>>();
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellA", t, c, wellToFields, descriptors);
    expect(descriptors.size).toBe(0);
  });

  it("well with one child → child descriptor gets wellProxyHandle", () => {
    const wellToFields = new Map<string, Set<string>>([["wellA", new Set(["fieldA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellA", t, c, wellToFields, descriptors);
    const desc = descriptors.get(proxyDescriptorKey("fieldA", t, c));
    expect(desc).toBeDefined();
    expect(desc!.wellProxyHandle).toBe(handle);
    expect(desc!.fieldProxyHandle).toBeNull();
  });

  it("well with multiple children → all child descriptors point at same handle", () => {
    const wellToFields = new Map<string, Set<string>>([
      ["wellA", new Set(["fieldA", "fieldB", "fieldC"])],
    ]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellA", t, c, wellToFields, descriptors);
    expect(descriptors.get(proxyDescriptorKey("fieldA", t, c))!.wellProxyHandle).toBe(handle);
    expect(descriptors.get(proxyDescriptorKey("fieldB", t, c))!.wellProxyHandle).toBe(handle);
    expect(descriptors.get(proxyDescriptorKey("fieldC", t, c))!.wellProxyHandle).toBe(handle);
    // Same handle reference (we don't copy).
    expect(descriptors.get(proxyDescriptorKey("fieldA", t, c))!.wellProxyHandle).toBe(
      descriptors.get(proxyDescriptorKey("fieldB", t, c))!.wellProxyHandle,
    );
  });

  it("pre-existing field descriptor → wellProxyHandle overwritten, fieldProxyHandle preserved", () => {
    const existingFieldHandle: ProxyHandle = { poolKey: "ds1|proxy|FieldProxy3D|32x32x16|ch0", slotIndex: 7 };
    const wellToFields = new Map<string, Set<string>>([["wellA", new Set(["fieldA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("fieldA", t, c), { fieldProxyHandle: existingFieldHandle, wellProxyHandle: null }],
    ]);
    propagateWellProxyToFields(handle, "wellA", t, c, wellToFields, descriptors);
    const desc = descriptors.get(proxyDescriptorKey("fieldA", t, c))!;
    expect(desc.wellProxyHandle).toBe(handle);
    expect(desc.fieldProxyHandle).toBe(existingFieldHandle);
  });

  it("missing well in wellToFields → no-op", () => {
    const wellToFields = new Map<string, Set<string>>([["wellA", new Set(["fieldA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellMissing", t, c, wellToFields, descriptors);
    expect(descriptors.size).toBe(0);
  });
});
