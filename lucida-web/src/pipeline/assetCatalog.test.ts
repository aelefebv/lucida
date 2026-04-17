import { describe, it, expect, vi } from "vitest";
import {
  AssetCatalog,
  type AssetCatalogWasm,
  type WireAssetCatalog,
  type WireAssetCatalogDelta,
} from "./assetCatalog.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface MockWasmScene extends AssetCatalogWasm {
  /** Every `apply_asset_catalog_delta` call recorded as `{datasetId, delta}`. */
  applyCalls: Array<{ datasetId: string; delta: WireAssetCatalogDelta }>;
  /** How many times the WASM call was invoked. */
  applyCount: number;
}

function createMockWasm(): MockWasmScene {
  const applyCalls: MockWasmScene["applyCalls"] = [];
  return {
    applyCalls,
    applyCount: 0,
    apply_asset_catalog_delta(json: string): void {
      const body = JSON.parse(json) as {
        dataset_id: string;
        delta: WireAssetCatalogDelta;
      };
      applyCalls.push({ datasetId: body.dataset_id, delta: body.delta });
      this.applyCount = applyCalls.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AssetCatalog", () => {
  describe("initial state", () => {
    it("snapshot() returns empty byEntity when nothing applied", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      const snap = cat.snapshot();
      expect(snap.byEntity.size).toBe(0);
    });

    it("hasProxy() returns false for unknown entity", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      expect(cat.hasProxy("anything", "WellProxy3D")).toBe(false);
    });
  });

  describe("applyInitial", () => {
    it("snapshot reflects entries after applyInitial", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      const initial: WireAssetCatalog = {
        entries: [
          { entity_id: "well-A1", kinds: ["WellProxy3D"] },
          { entity_id: "field-F17", kinds: ["FieldProxy3D"] },
        ],
      };
      cat.applyInitial("ds1", initial);

      const snap = cat.snapshot();
      expect(snap.byEntity.size).toBe(2);
      expect(snap.byEntity.get("well-A1")?.kinds.has("WellProxy3D")).toBe(true);
      expect(snap.byEntity.get("field-F17")?.kinds.has("FieldProxy3D")).toBe(true);
    });

    it("forwards through WASM as a delta with the same dataset_id", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", { entries: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }] });

      expect(wasm.applyCount).toBe(1);
      expect(wasm.applyCalls[0].datasetId).toBe("ds1");
      expect(wasm.applyCalls[0].delta.added).toHaveLength(1);
      expect(wasm.applyCalls[0].delta.added[0].entity_id).toBe("e1");
    });

    it("empty initial catalog still pushes an empty delta", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", { entries: [] });

      expect(wasm.applyCount).toBe(1);
      expect(wasm.applyCalls[0].delta.added).toHaveLength(0);
      expect(cat.snapshot().byEntity.size).toBe(0);
    });
  });

  describe("applyDelta", () => {
    it("snapshot includes new entries; existing entries remain", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", {
        entries: [{ entity_id: "e1", kinds: ["WellProxy3D"] }],
      });

      const delta: WireAssetCatalogDelta = {
        added: [{ entity_id: "e2", kinds: ["FieldProxy3D"] }],
      };
      cat.applyDelta("ds1", delta);

      const snap = cat.snapshot();
      expect(snap.byEntity.size).toBe(2);
      expect(snap.byEntity.get("e1")?.kinds.has("WellProxy3D")).toBe(true);
      expect(snap.byEntity.get("e2")?.kinds.has("FieldProxy3D")).toBe(true);
    });

    it("merges kinds for the same entity across deltas", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyDelta("ds1", { added: [{ entity_id: "e1", kinds: ["WellProxy3D"] }] });
      cat.applyDelta("ds1", { added: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }] });

      const snap = cat.snapshot();
      const kinds = snap.byEntity.get("e1")!.kinds;
      expect(kinds.size).toBe(2);
      expect(kinds.has("WellProxy3D")).toBe(true);
      expect(kinds.has("FieldProxy3D")).toBe(true);
    });

    it("re-applying the same delta is idempotent on the snapshot", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      const delta: WireAssetCatalogDelta = {
        added: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }],
      };
      cat.applyDelta("ds1", delta);
      cat.applyDelta("ds1", delta);

      const snap = cat.snapshot();
      const kinds = snap.byEntity.get("e1")!.kinds;
      expect(kinds.size).toBe(1);
      expect(kinds.has("FieldProxy3D")).toBe(true);
    });

    it("forwards each call through WASM exactly once", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyDelta("ds1", { added: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }] });
      cat.applyDelta("ds1", { added: [{ entity_id: "e2", kinds: ["WellProxy3D"] }] });
      expect(wasm.applyCount).toBe(2);
    });
  });

  describe("hasProxy", () => {
    it("returns true when the kind is present", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", {
        entries: [{ entity_id: "e1", kinds: ["WellProxy3D", "FieldProxy3D"] }],
      });
      expect(cat.hasProxy("e1", "WellProxy3D")).toBe(true);
      expect(cat.hasProxy("e1", "FieldProxy3D")).toBe(true);
    });

    it("returns false when the kind is absent", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", {
        entries: [{ entity_id: "e1", kinds: ["WellProxy3D"] }],
      });
      expect(cat.hasProxy("e1", "FieldProxy3D")).toBe(false);
    });

    it("looks across all datasets", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", {
        entries: [{ entity_id: "shared", kinds: ["FieldProxy3D"] }],
      });
      cat.applyInitial("ds2", {
        entries: [{ entity_id: "shared", kinds: ["WellProxy3D"] }],
      });
      expect(cat.hasProxy("shared", "FieldProxy3D")).toBe(true);
      expect(cat.hasProxy("shared", "WellProxy3D")).toBe(true);
    });
  });

  describe("removeDataset", () => {
    it("removes only that dataset's entries from the snapshot", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", { entries: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }] });
      cat.applyInitial("ds2", { entries: [{ entity_id: "e2", kinds: ["WellProxy3D"] }] });

      cat.removeDataset("ds1");
      const snap = cat.snapshot();
      expect(snap.byEntity.has("e1")).toBe(false);
      expect(snap.byEntity.has("e2")).toBe(true);
    });

    it("does NOT push to WASM (mirror only)", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", { entries: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }] });
      const callsBefore = wasm.applyCount;
      cat.removeDataset("ds1");
      expect(wasm.applyCount).toBe(callsBefore);
    });

    it("preserves entries owned by other datasets when a dataset is removed", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      // Same entity present in both datasets.
      cat.applyInitial("ds1", { entries: [{ entity_id: "shared", kinds: ["FieldProxy3D"] }] });
      cat.applyInitial("ds2", { entries: [{ entity_id: "shared", kinds: ["WellProxy3D"] }] });

      cat.removeDataset("ds1");
      // ds2 still advertises WellProxy3D for "shared".
      const snap = cat.snapshot();
      expect(snap.byEntity.get("shared")?.kinds.has("WellProxy3D")).toBe(true);
      expect(snap.byEntity.get("shared")?.kinds.has("FieldProxy3D")).toBe(false);
    });
  });

  describe("snapshot isolation", () => {
    it("mutating the returned snapshot does not affect the catalog", () => {
      const wasm = createMockWasm();
      const cat = new AssetCatalog(wasm);
      cat.applyInitial("ds1", { entries: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }] });

      const snap = cat.snapshot();
      snap.byEntity.get("e1")!.kinds.delete("FieldProxy3D");

      // Catalog still has it.
      expect(cat.hasProxy("e1", "FieldProxy3D")).toBe(true);
    });
  });

  describe("WASM forwarding contract", () => {
    it("propagates errors from WASM apply", () => {
      const wasm: AssetCatalogWasm = {
        apply_asset_catalog_delta: vi.fn(() => {
          throw new Error("wasm bad");
        }),
      };
      const cat = new AssetCatalog(wasm);
      expect(() =>
        cat.applyDelta("ds1", { added: [{ entity_id: "e1", kinds: ["FieldProxy3D"] }] }),
      ).toThrow("wasm bad");
    });
  });
});
