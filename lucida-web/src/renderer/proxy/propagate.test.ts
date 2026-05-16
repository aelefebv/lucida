/**
 * Tests for `propagateWellProxyToFields`. Pure Map mutation — no GPU.
 *
 * Locks behavior the original `handleProxyAssetData` inline branch
 * provided so Slice 5's extraction can't regress:
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
import type { EntityProxyDescriptor } from "../workerContext.ts";

const handle: ProxyHandle = { poolKey: "ds1|proxy|WellProxy3D|64x64x32|ch0", slotIndex: 3 };

describe("propagateWellProxyToFields", () => {
  it("well with no children → no-op (no descriptor entries written)", () => {
    const wellToFields = new Map<string, Set<string>>();
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellA", wellToFields, descriptors);
    expect(descriptors.size).toBe(0);
  });

  it("well with one child → child descriptor gets wellProxyHandle", () => {
    const wellToFields = new Map<string, Set<string>>([["wellA", new Set(["fieldA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellA", wellToFields, descriptors);
    const desc = descriptors.get("fieldA");
    expect(desc).toBeDefined();
    expect(desc!.wellProxyHandle).toBe(handle);
    expect(desc!.fieldProxyHandle).toBeNull();
  });

  it("well with multiple children → all child descriptors point at same handle", () => {
    const wellToFields = new Map<string, Set<string>>([
      ["wellA", new Set(["fieldA", "fieldB", "fieldC"])],
    ]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellA", wellToFields, descriptors);
    expect(descriptors.get("fieldA")!.wellProxyHandle).toBe(handle);
    expect(descriptors.get("fieldB")!.wellProxyHandle).toBe(handle);
    expect(descriptors.get("fieldC")!.wellProxyHandle).toBe(handle);
    // Same handle reference (we don't copy).
    expect(descriptors.get("fieldA")!.wellProxyHandle).toBe(
      descriptors.get("fieldB")!.wellProxyHandle,
    );
  });

  it("pre-existing field descriptor → wellProxyHandle overwritten, fieldProxyHandle preserved", () => {
    const existingFieldHandle: ProxyHandle = { poolKey: "ds1|proxy|FieldProxy3D|32x32x16|ch0", slotIndex: 7 };
    const wellToFields = new Map<string, Set<string>>([["wellA", new Set(["fieldA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>([
      ["fieldA", { fieldProxyHandle: existingFieldHandle, wellProxyHandle: null }],
    ]);
    propagateWellProxyToFields(handle, "wellA", wellToFields, descriptors);
    const desc = descriptors.get("fieldA")!;
    expect(desc.wellProxyHandle).toBe(handle);
    expect(desc.fieldProxyHandle).toBe(existingFieldHandle);
  });

  it("missing well in wellToFields → no-op", () => {
    const wellToFields = new Map<string, Set<string>>([["wellA", new Set(["fieldA"])]]);
    const descriptors = new Map<string, EntityProxyDescriptor>();
    propagateWellProxyToFields(handle, "wellMissing", wellToFields, descriptors);
    expect(descriptors.size).toBe(0);
  });
});
