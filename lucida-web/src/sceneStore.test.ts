import { describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import { noteSceneWrite, SceneStore } from "./sceneStore.ts";

/** The scene reads the store makes, over plain fields. */
function fakeScene() {
  const state = {
    z: 0,
    t: 0,
    c: 0,
    multi: false,
    mode: "slice",
    epochs: { content: 0, layout: 0, view: 0, selection: 0, asset: 0, annotation: 0 },
  };
  const scene = {
    z: () => state.z,
    t: () => state.t,
    c: () => state.c,
    multi_channel: () => state.multi,
    camera_mode: () => state.mode,
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
    state.c = 2;
    state.epochs.selection++;

    store.subscribe(() => {});

    expect(store.getView().c).toBe(2);
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
