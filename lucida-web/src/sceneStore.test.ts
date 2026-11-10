import { describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import { noteSceneWrite, SceneStore } from "./sceneStore.ts";

/** The scene reads the store makes, over plain fields. */
function fakeScene() {
  const state = {
    z: 0,
    t: 0,
    layers: [] as unknown[],
    mode: "slice",
    comparison: null as unknown,
    epochs: { content: 0, layout: 0, view: 0, selection: 0, annotation: 0, comparison: 0 },
  };
  const scene = {
    z: () => state.z,
    t: () => state.t,
    active_view: () => 0,
    slice_plane: () => "xy",
    cut_index: () => state.z,
    resolved_layers: () => JSON.stringify(state.layers),
    camera_mode: () => state.mode,
    comparison: () => JSON.stringify(state.comparison),
    epochs: () => JSON.stringify(state.epochs),
  } as unknown as WasmScene;
  return { scene, state };
}

describe("SceneStore", () => {
  it("reads the scene back after an announced write", () => {
    const { scene, state } = fakeScene();
    const store = new SceneStore(() => scene);
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    state.z = 7;
    state.mode = "arcball";
    state.epochs.selection++;
    state.epochs.view++;
    noteSceneWrite();

    expect(store.getView()).toMatchObject({ z: 7, cameraMode: "arcball", viewMode: "3d" });
    expect(listener).toHaveBeenCalled();
  });

  it("keeps the view's identity when only the camera moved", () => {
    const { scene, state } = fakeScene();
    const store = new SceneStore(() => scene);
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    const before = store.getView();
    const epochsBefore = store.getEpochs();

    state.epochs.view++;
    noteSceneWrite();

    // A reader of the epochs hears the pan; a reader of the selectors keeps
    // its snapshot and doesn't re-render.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getEpochs()).not.toBe(epochsBefore);
    expect(store.getView()).toBe(before);
  });

  it("reads the comparison apart from the view, so a divider drag keeps the view's identity", () => {
    const { scene, state } = fakeScene();
    const store = new SceneStore(() => scene);
    store.subscribe(() => {});
    const view = store.getView();
    expect(store.getComparison()).toBeNull();

    state.comparison = { a: "a", b: "b", mode: "swipe", divider: 0.4, showing: "a" };
    state.epochs.comparison++;
    noteSceneWrite();

    expect(store.getComparison()).toMatchObject({ divider: 0.4 });
    expect(store.getView()).toBe(view);
    const comparison = store.getComparison();
    state.epochs.view++;
    noteSceneWrite();
    expect(store.getComparison()).toBe(comparison);
  });

  it("stays quiet when a write moved no epoch", () => {
    const { scene } = fakeScene();
    const store = new SceneStore(() => scene);
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    noteSceneWrite();

    expect(listener).not.toHaveBeenCalled();
  });

  it("observes writes only while it has a listener", () => {
    const { scene, state } = fakeScene();
    const store = new SceneStore(() => scene);
    const read = vi.spyOn(scene, "epochs");
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    read.mockClear();

    state.epochs.selection++;
    noteSceneWrite();

    expect(read).not.toHaveBeenCalled();
  });

  it("catches up on subscribe with a write it missed", () => {
    const { scene, state } = fakeScene();
    const store = new SceneStore(() => scene);
    state.t = 2;
    state.epochs.selection++;

    store.subscribe(() => {});

    expect(store.getView().t).toBe(2);
  });

  it("reads what each layer shows, and keeps it across a camera move", () => {
    const { scene, state } = fakeScene();
    const store = new SceneStore(() => scene);
    store.subscribe(() => {});
    const read = vi.spyOn(scene, "resolved_layers");

    state.layers = [{ dataset_id: "a", solo: 1, channels: [{ channel: 1 }] }];
    state.epochs.selection++;
    noteSceneWrite();
    const layers = store.getView().layers;
    expect(layers.get("a")?.solo).toBe(1);

    read.mockClear();
    state.epochs.view++;
    noteSceneWrite();
    expect(read).not.toHaveBeenCalled();
    expect(store.getView().layers).toBe(layers);
  });

  it("reads defaults until there is a scene", () => {
    const { scene } = fakeScene();
    let current: WasmScene | null = null;
    const store = new SceneStore(() => current);
    store.subscribe(() => {});
    expect(store.getView()).toMatchObject({ z: 0, viewMode: "2d" });
    expect(store.getEpochs()).toBeNull();

    current = scene;
    store.sync();

    expect(store.getEpochs()).not.toBeNull();
  });
});
