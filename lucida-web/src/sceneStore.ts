/**
 * The view state React reads, held by the WASM scene alone.
 *
 * The scene owns the selectors (z, t, c, multi-channel) and the camera. React
 * keeps no copy of them: a control writes the scene, and a render reads the
 * scene back through this store. A copy would need every path that writes the
 * scene (a saved view, a followed peer, a restore) to update it too, and the
 * one that forgot would be reverted by the next write from the copy.
 *
 * The store learns of writes from {@link noteSceneWrite}, which the viewport
 * command path and the invalidation intents call, and re-reads the scene only
 * when its epochs moved. Its snapshot keeps its identity until a value in it
 * changes, so a pan republishes the epochs without re-rendering a reader of
 * the selectors.
 */
import type { WasmScene } from "lucida-core";
import type { ViewMode } from "./types.ts";

export type CameraMode = "slice" | "arcball" | "fly";

export interface SceneView {
  readonly z: number;
  readonly t: number;
  readonly c: number;
  readonly multiChannel: boolean;
  readonly cameraMode: CameraMode;
  /** `2d` for the slice camera, `3d` for either volume camera. */
  readonly viewMode: ViewMode;
}

/** The epochs that can move what a saved view records. Annotations can't,
 *  so their epoch is left out. */
export interface ViewEpochs {
  readonly content: number;
  readonly layout: number;
  readonly view: number;
  readonly selection: number;
}

/** A scene before its first write, and the page before it has a scene. */
const NO_SCENE_VIEW: SceneView = {
  z: 0,
  t: 0,
  c: 0,
  multiChannel: false,
  cameraMode: "slice",
  viewMode: "2d",
};

const writeListeners = new Set<() => void>();

/** Tell every store that something wrote the scene. Cheap enough to call on
 *  every write: a store compares epochs before it reads anything else. */
export function noteSceneWrite(): void {
  for (const listener of [...writeListeners]) listener();
}

export class SceneStore {
  private scene: WasmScene | null = null;
  private epochs: ViewEpochs | null = null;
  private view: SceneView = NO_SCENE_VIEW;
  private readonly listeners = new Set<() => void>();
  private readonly getScene: () => WasmScene | null;

  constructor(getScene: () => WasmScene | null) {
    this.getScene = getScene;
  }

  /** Listen for a change to the view or to its epochs. The store observes
   *  writes only while it has a listener. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    writeListeners.add(this.sync);
    // A write before the first listener went unobserved.
    this.sync();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) writeListeners.delete(this.sync);
    };
  };

  /** The selectors and camera mode, as one snapshot whose identity changes
   *  only when one of them does. */
  getView = (): SceneView => this.view;

  /** The epochs as last read, or null without a scene. A new object each
   *  time one of them moves. */
  getEpochs = (): ViewEpochs | null => this.epochs;

  /** Re-read the scene if it was replaced or its epochs moved, and tell the
   *  listeners. */
  sync = (): void => {
    const scene = this.getScene();
    const epochs = scene ? readEpochs(scene) : null;
    if (scene === this.scene && sameEpochs(epochs, this.epochs)) return;
    this.scene = scene;
    this.epochs = epochs;
    const view = scene ? readView(scene) : NO_SCENE_VIEW;
    if (!sameView(view, this.view)) this.view = view;
    for (const listener of [...this.listeners]) listener();
  };
}

function readEpochs(scene: WasmScene): ViewEpochs {
  const all = JSON.parse(scene.epochs()) as ViewEpochs;
  return { content: all.content, layout: all.layout, view: all.view, selection: all.selection };
}

function sameEpochs(a: ViewEpochs | null, b: ViewEpochs | null): boolean {
  if (a === null || b === null) return a === b;
  return a.content === b.content && a.layout === b.layout && a.view === b.view && a.selection === b.selection;
}

function readView(scene: WasmScene): SceneView {
  const mode = scene.camera_mode();
  const cameraMode: CameraMode = mode === "fly" ? "fly" : mode === "arcball" ? "arcball" : "slice";
  return {
    z: scene.z(),
    t: scene.t(),
    c: scene.c(),
    multiChannel: scene.multi_channel(),
    cameraMode,
    viewMode: cameraMode === "slice" ? "2d" : "3d",
  };
}

function sameView(a: SceneView, b: SceneView): boolean {
  return (
    a.z === b.z &&
    a.t === b.t &&
    a.c === b.c &&
    a.multiChannel === b.multiChannel &&
    a.cameraMode === b.cameraMode
  );
}
