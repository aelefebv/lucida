import { describe, it, expect } from "vitest";
import {
  LayoutRegistry,
  type LayoutInfo,
  type LayoutRegistryWasm,
} from "./layoutRegistry.ts";
import type { LayoutSpec } from "../contentTypes.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface MockWasm extends LayoutRegistryWasm {
  applyCommandCalls: string[];
  /** Override the JSON returned by `available_layouts(datasetId)`. */
  setAvailable(datasetId: string, layouts: LayoutInfo[]): void;
}

function createMockWasm(): MockWasm {
  const applyCommandCalls: string[] = [];
  const availableData = new Map<string, LayoutInfo[]>();
  return {
    applyCommandCalls,
    apply_command(json: string): void {
      applyCommandCalls.push(json);
    },
    available_layouts(datasetId: string): string {
      return JSON.stringify(availableData.get(datasetId) ?? []);
    },
    setAvailable(datasetId: string, layouts: LayoutInfo[]): void {
      availableData.set(datasetId, layouts);
    },
  };
}

function makeSpec(id: string, name: string): LayoutSpec {
  return {
    id,
    name,
    placements: [{ entity_id: "e0", position: [0, 0] }],
  };
}

const noopSend = (_json: string) => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LayoutRegistry", () => {
  describe("initial state", () => {
    it("available() returns [] for unknown dataset", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      expect(reg.available("ds1")).toEqual([]);
    });

    it("activeId() returns null for unknown dataset", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      expect(reg.activeId("ds1")).toBeNull();
    });

    it("getSpec() returns null for unknown layout", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      expect(reg.getSpec("ds1", "anything")).toBeNull();
    });
  });

  describe("register", () => {
    it("forwards to wasm.apply_command with register_layout JSON", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      const spec = makeSpec("derived:dense-square", "Dense (square)");
      wasm.setAvailable("ds1", [{ id: "default", name: "Default" }, { id: "derived:dense-square", name: "Dense (square)" }]);

      reg.register("ds1", spec, noopSend);

      expect(wasm.applyCommandCalls).toHaveLength(1);
      const parsed = JSON.parse(wasm.applyCommandCalls[0]);
      expect(parsed.type).toBe("register_layout");
      expect(parsed.dataset_id).toBe("ds1");
      expect(parsed.layout.id).toBe("derived:dense-square");
    });

    it("invokes sendCommand with the same JSON it sends to apply_command", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      const sent: string[] = [];
      wasm.setAvailable("ds1", []);
      reg.register("ds1", makeSpec("a", "A"), (json) => sent.push(json));
      expect(sent).toEqual(wasm.applyCommandCalls);
    });

    it("refreshes the available mirror from wasm after registering", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
      reg.register("ds1", makeSpec("b", "B"), noopSend);
      expect(reg.available("ds1")).toEqual([
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ]);
    });

    it("stores the spec so getSpec() returns it", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      const spec = makeSpec("derived:plate-grid", "Plate grid");
      wasm.setAvailable("ds1", [{ id: "derived:plate-grid", name: "Plate grid" }]);
      reg.register("ds1", spec, noopSend);
      expect(reg.getSpec("ds1", "derived:plate-grid")).toEqual(spec);
    });

    it("notifies subscribers", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      let calls = 0;
      reg.subscribe(() => {
        calls += 1;
      });
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }]);
      reg.register("ds1", makeSpec("a", "A"), noopSend);
      expect(calls).toBeGreaterThan(0);
    });

    it("re-registering same id overwrites the local spec mirror", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }]);
      const spec1: LayoutSpec = { id: "a", name: "A", placements: [{ entity_id: "e0", position: [0, 0] }] };
      const spec2: LayoutSpec = { id: "a", name: "A", placements: [{ entity_id: "e0", position: [42, 42] }] };
      reg.register("ds1", spec1, noopSend);
      reg.register("ds1", spec2, noopSend);
      expect(reg.getSpec("ds1", "a")).toEqual(spec2);
    });
  });

  describe("setActive", () => {
    it("forwards to wasm.apply_command with set_active_layout JSON", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      reg.setActive("ds1", "derived:dense-square", noopSend);
      expect(wasm.applyCommandCalls).toHaveLength(1);
      const parsed = JSON.parse(wasm.applyCommandCalls[0]);
      expect(parsed.type).toBe("set_active_layout");
      expect(parsed.dataset_id).toBe("ds1");
      expect(parsed.layout_id).toBe("derived:dense-square");
    });

    it("invokes sendCommand", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      const sent: string[] = [];
      reg.setActive("ds1", "x", (json) => sent.push(json));
      expect(sent).toHaveLength(1);
    });

    it("updates activeId() mirror", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      reg.setActive("ds1", "x", noopSend);
      expect(reg.activeId("ds1")).toBe("x");
    });

    it("notifies subscribers", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      let calls = 0;
      reg.subscribe(() => {
        calls += 1;
      });
      reg.setActive("ds1", "x", noopSend);
      expect(calls).toBe(1);
    });
  });

  describe("setActiveLocal", () => {
    it("updates activeId() without calling apply_command or sendCommand", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      const sent: string[] = [];
      reg.subscribe(() => {});
      reg.setActiveLocal("ds1", "x");
      expect(wasm.applyCommandCalls).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(reg.activeId("ds1")).toBe("x");
    });

    it("notifies subscribers", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      let calls = 0;
      reg.subscribe(() => {
        calls += 1;
      });
      reg.setActiveLocal("ds1", "x");
      expect(calls).toBe(1);
    });
  });

  describe("refresh", () => {
    it("parses WASM JSON into available()", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
      reg.refresh("ds1");
      expect(reg.available("ds1")).toEqual([
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ]);
    });

    it("does not touch active id", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      reg.setActiveLocal("ds1", "x");
      wasm.setAvailable("ds1", [{ id: "y", name: "Y" }]);
      reg.refresh("ds1");
      expect(reg.activeId("ds1")).toBe("x");
    });

    it("notifies subscribers", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      let calls = 0;
      reg.subscribe(() => {
        calls += 1;
      });
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }]);
      reg.refresh("ds1");
      expect(calls).toBe(1);
    });
  });

  describe("removeDataset", () => {
    it("clears all maps for that dataset", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }]);
      reg.register("ds1", makeSpec("a", "A"), noopSend);
      reg.setActive("ds1", "a", noopSend);

      reg.removeDataset("ds1");

      expect(reg.available("ds1")).toEqual([]);
      expect(reg.activeId("ds1")).toBeNull();
      expect(reg.getSpec("ds1", "a")).toBeNull();
    });

    it("does NOT invoke apply_command (mirror only)", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }]);
      reg.register("ds1", makeSpec("a", "A"), noopSend);
      const before = wasm.applyCommandCalls.length;
      reg.removeDataset("ds1");
      expect(wasm.applyCommandCalls.length).toBe(before);
    });

    it("notifies subscribers", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      let calls = 0;
      reg.subscribe(() => {
        calls += 1;
      });
      reg.removeDataset("ds1");
      expect(calls).toBe(1);
    });
  });

  describe("subscribe", () => {
    it("returns an unsubscribe function that stops notifications", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      let calls = 0;
      const unsub = reg.subscribe(() => {
        calls += 1;
      });
      reg.setActiveLocal("ds1", "x");
      expect(calls).toBe(1);
      unsub();
      reg.setActiveLocal("ds1", "y");
      expect(calls).toBe(1);
    });
  });

  describe("getVersion", () => {
    it("starts at 0 and bumps on every notify", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      expect(reg.getVersion()).toBe(0);
      reg.setActiveLocal("ds1", "x");
      expect(reg.getVersion()).toBe(1);
      reg.setActiveLocal("ds1", "y");
      expect(reg.getVersion()).toBe(2);
      reg.removeDataset("ds1");
      expect(reg.getVersion()).toBe(3);
    });
  });

  describe("multi-dataset isolation", () => {
    it("register on ds1 does not affect ds2's available/active", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }]);
      wasm.setAvailable("ds2", [{ id: "b", name: "B" }]);
      reg.register("ds1", makeSpec("a", "A"), noopSend);
      reg.setActive("ds1", "a", noopSend);
      // ds2 untouched
      expect(reg.available("ds2")).toEqual([]);
      expect(reg.activeId("ds2")).toBeNull();
    });

    it("removeDataset only affects the targeted dataset", () => {
      const wasm = createMockWasm();
      const reg = new LayoutRegistry(wasm);
      wasm.setAvailable("ds1", [{ id: "a", name: "A" }]);
      wasm.setAvailable("ds2", [{ id: "b", name: "B" }]);
      reg.register("ds1", makeSpec("a", "A"), noopSend);
      reg.register("ds2", makeSpec("b", "B"), noopSend);
      reg.removeDataset("ds1");
      expect(reg.available("ds2")).toEqual([{ id: "b", name: "B" }]);
      expect(reg.getSpec("ds2", "b")?.id).toBe("b");
    });
  });
});
