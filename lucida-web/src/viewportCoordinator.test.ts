import { describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import { createViewportCoordinator, createViewportHistory } from "./viewportCoordinator.ts";

function makeHarness() {
  const scene = { apply_command: vi.fn() } as unknown as WasmScene;
  const loop = {
    markInteractiveDirty: vi.fn(),
    markResidencyDirty: vi.fn(),
  };
  const deps = {
    sceneRef: { current: scene as WasmScene | null },
    loopRef: { current: loop },
    breakFollow: vi.fn(),
    emitPresence: vi.fn(),
    emitDatasetPresence: vi.fn(),
    recordLiveView: vi.fn(),
  };
  return { scene, loop, deps, coordinator: createViewportCoordinator(deps) };
}

describe("createViewportCoordinator", () => {
  it("publishes every side effect exactly once for a command batch", () => {
    const { scene, loop, deps, coordinator } = makeHarness();

    expect(coordinator.apply([
      { type: "set_t", t: 4 },
      { type: "set_c", c: 2 },
    ], { source: "dimension_change", invalidation: "display" })).toBe(true);

    expect(scene.apply_command).toHaveBeenCalledTimes(2);
    expect(scene.apply_command).toHaveBeenNthCalledWith(1, JSON.stringify({ type: "set_t", t: 4 }));
    expect(scene.apply_command).toHaveBeenNthCalledWith(2, JSON.stringify({ type: "set_c", c: 2 }));
    expect(deps.breakFollow).toHaveBeenCalledTimes(1);
    expect(deps.emitPresence).toHaveBeenCalledTimes(1);
    expect(deps.recordLiveView).toHaveBeenCalledTimes(1);
    expect(loop.markInteractiveDirty).toHaveBeenCalledOnce();
    expect(loop.markInteractiveDirty).toHaveBeenCalledWith("dimension_change");
    expect(loop.markResidencyDirty).not.toHaveBeenCalled();
  });

  it("supports an atomic custom scene transaction with one publication boundary", () => {
    const { scene, loop, deps, coordinator } = makeHarness();
    const directMutation = vi.fn();

    const applied = coordinator.transact((current, apply) => {
      expect(current).toBe(scene);
      directMutation();
      apply({ type: "set_z", z: 7 });
      apply({ type: "set_t", t: 3 });
    }, {
      source: "annotation_context",
      publication: "dataset-presence",
      invalidation: "restore",
    });

    expect(applied).toBe(true);
    expect(directMutation).toHaveBeenCalledOnce();
    expect(scene.apply_command).toHaveBeenCalledTimes(2);
    expect(deps.emitPresence).not.toHaveBeenCalled();
    expect(deps.emitDatasetPresence).toHaveBeenCalledOnce();
    expect(deps.breakFollow).toHaveBeenCalledOnce();
    expect(deps.recordLiveView).toHaveBeenCalledOnce();
    expect(loop.markInteractiveDirty).toHaveBeenCalledWith("annotation_context");
    expect(loop.markResidencyDirty).toHaveBeenCalledWith("annotation_context");
  });

  it("routes data-driven display changes through the same boundary with residency invalidation", () => {
    const { scene, loop, deps, coordinator } = makeHarness();

    expect(coordinator.apply(
      {
        type: "set_channel_contrast",
        dataset_id: "ds-a",
        channel: 2,
        min: 4,
        max: 90,
      },
      {
        source: "auto_contrast",
        breakFollow: false,
        publication: "dataset-presence",
        invalidation: "residency",
        history: { skip: true },
      },
    )).toBe(true);

    expect(scene.apply_command).toHaveBeenCalledOnce();
    expect(deps.breakFollow).not.toHaveBeenCalled();
    expect(deps.emitPresence).not.toHaveBeenCalled();
    expect(deps.emitDatasetPresence).toHaveBeenCalledOnce();
    expect(deps.recordLiveView).toHaveBeenCalledOnce();
    expect(loop.markInteractiveDirty).not.toHaveBeenCalled();
    expect(loop.markResidencyDirty).toHaveBeenCalledWith("auto_contrast");
  });

  it("publishes no follow, presence, URL, or render effects when a scene write fails", () => {
    const { scene, loop, deps, coordinator } = makeHarness();
    vi.mocked(scene.apply_command).mockImplementationOnce(() => {
      throw new Error("scene rejected command");
    });

    expect(() => coordinator.apply(
      { type: "set_z", z: 9 },
      { source: "failed_change" },
    )).toThrow("scene rejected command");

    expect(deps.breakFollow).not.toHaveBeenCalled();
    expect(deps.emitPresence).not.toHaveBeenCalled();
    expect(deps.emitDatasetPresence).not.toHaveBeenCalled();
    expect(deps.recordLiveView).not.toHaveBeenCalled();
    expect(loop.markInteractiveDirty).not.toHaveBeenCalled();
    expect(loop.markResidencyDirty).not.toHaveBeenCalled();
  });

  it("rolls back both canonical presence slices when a later batch command fails", () => {
    let presence = { view: { t: 0 } };
    let datasetPresence = { dataset_order: ["ds-a"] };
    let calls = 0;
    const scene = {
      export_presence: () => JSON.stringify(presence),
      export_dataset_presence: () => JSON.stringify(datasetPresence),
      import_presence: vi.fn((json: string) => { presence = JSON.parse(json); }),
      import_dataset_presence: vi.fn((json: string) => { datasetPresence = JSON.parse(json); }),
      apply_command: vi.fn(() => {
        calls++;
        if (calls === 1) {
          presence = { view: { t: 7 } };
          datasetPresence = { dataset_order: ["ds-b"] };
          return;
        }
        throw new Error("second command rejected");
      }),
    } as unknown as WasmScene;
    const deps = {
      sceneRef: { current: scene as WasmScene | null },
      loopRef: { current: null },
      breakFollow: vi.fn(),
      emitPresence: vi.fn(),
      emitDatasetPresence: vi.fn(),
      recordLiveView: vi.fn(),
      history: createViewportHistory("workspace-a"),
    };
    const coordinator = createViewportCoordinator(deps);

    expect(() => coordinator.apply([
      { type: "set_t", t: 7 },
      { type: "set_c", c: 2 },
    ], { source: "atomic_batch" })).toThrow("second command rejected");

    expect(presence).toEqual({ view: { t: 0 } });
    expect(datasetPresence).toEqual({ dataset_order: ["ds-a"] });
    expect(deps.breakFollow).not.toHaveBeenCalled();
    expect(deps.emitPresence).not.toHaveBeenCalled();
    expect(deps.recordLiveView).not.toHaveBeenCalled();
  });

  it("does nothing while the scene is unavailable", () => {
    const { loop, deps, coordinator } = makeHarness();
    deps.sceneRef.current = null;

    expect(coordinator.apply({ type: "set_z", z: 1 }, { source: "no_scene" })).toBe(false);
    expect(deps.breakFollow).not.toHaveBeenCalled();
    expect(deps.emitPresence).not.toHaveBeenCalled();
    expect(deps.recordLiveView).not.toHaveBeenCalled();
    expect(loop.markInteractiveDirty).not.toHaveBeenCalled();
  });

  it("can commit a non-command restore without unrelated publications", () => {
    const { loop, deps, coordinator } = makeHarness();
    const restore = vi.fn();

    expect(coordinator.commit(restore, {
      source: "saved_view_restore",
      breakFollow: false,
      publication: "none",
      recordLiveView: false,
      invalidation: "restore",
    })).toBe(true);

    expect(restore).toHaveBeenCalledOnce();
    expect(deps.breakFollow).not.toHaveBeenCalled();
    expect(deps.emitPresence).not.toHaveBeenCalled();
    expect(deps.recordLiveView).not.toHaveBeenCalled();
    expect(loop.markInteractiveDirty).toHaveBeenCalledWith("saved_view_restore");
    expect(loop.markResidencyDirty).toHaveBeenCalledWith("saved_view_restore");
  });

  it("captures canonical presence state, coalesces a gesture, and restores both local slices", () => {
    let presence = { camera: { x: 0 }, view: {}, display: {} };
    let datasetPresence = { dataset_order: ["ds"], dataset_settings: { ds: { opacity: 1 } } };
    const scene = {
      export_presence: vi.fn(() => JSON.stringify(presence)),
      export_dataset_presence: vi.fn(() => JSON.stringify(datasetPresence)),
      import_presence: vi.fn((json: string) => { presence = JSON.parse(json); }),
      import_dataset_presence: vi.fn((json: string) => { datasetPresence = JSON.parse(json); }),
      apply_command: vi.fn(() => {
        presence = { ...presence, camera: { x: presence.camera.x + 1 } };
      }),
    } as unknown as WasmScene;
    const history = createViewportHistory("workspace-a");
    const deps = {
      sceneRef: { current: scene as WasmScene | null },
      loopRef: { current: { markInteractiveDirty: vi.fn(), markResidencyDirty: vi.fn() } },
      breakFollow: vi.fn(),
      emitPresence: vi.fn(),
      emitDatasetPresence: vi.fn(),
      recordLiveView: vi.fn(),
      afterHistoryRestore: vi.fn(),
      history,
    };
    const coordinator = createViewportCoordinator(deps);

    const options = {
      source: "slice_pan",
      history: { label: "pan", coalesceKey: "pan", coalesceWindowMs: Infinity },
    } as const;
    coordinator.apply({ type: "pan", dx: 1, dy: 0 }, options);
    coordinator.apply({ type: "pan", dx: 1, dy: 0 }, options);
    expect(history.getState().undoReason).toBe("Undo pan");
    expect(coordinator.undo()).toBe(true);
    expect(presence.camera.x).toBe(0);
    expect(datasetPresence.dataset_order).toEqual(["ds"]);
    expect(deps.emitPresence).toHaveBeenCalledTimes(3);
    expect(deps.emitDatasetPresence).toHaveBeenCalledTimes(1);
    expect(coordinator.redo()).toBe(true);
    expect(presence.camera.x).toBe(2);
    expect(deps.afterHistoryRestore).toHaveBeenCalledTimes(2);
  });

  it("records saved-view and Explore restores as explicit external transitions", () => {
    let presence = "before";
    const scene = {
      export_presence: () => presence,
      export_dataset_presence: () => "layers",
      import_presence: vi.fn((value: string) => { presence = value; }),
      import_dataset_presence: vi.fn(),
    } as unknown as WasmScene;
    const history = createViewportHistory("workspace-a");
    const coordinator = createViewportCoordinator({
      sceneRef: { current: scene },
      loopRef: { current: null },
      breakFollow: vi.fn(),
      emitPresence: vi.fn(),
      emitDatasetPresence: vi.fn(),
      recordLiveView: vi.fn(),
      history,
    });

    const checkpoint = coordinator.checkpoint();
    presence = "saved-view";
    coordinator.commitExternal(checkpoint, {
      source: "saved_view_open",
      history: { label: "saved view" },
    });
    expect(history.getState().undoReason).toBe("Undo saved view");
    expect(coordinator.undo()).toBe(true);
    expect(presence).toBe("before");
  });
});
