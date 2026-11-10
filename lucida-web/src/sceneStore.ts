/**
 * The view state React reads, held by the WASM scene alone.
 *
 * The scene owns the selectors (z, t), what each layer shows, and the camera.
 * React keeps no copy of them: a control writes the scene, and a render reads the
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
import { readComparison, type Comparison } from "./comparison.ts";
import { parseResolvedLayers, type ResolvedLayers } from "./resolvedLayers.ts";
import type { ViewMode } from "./types.ts";
import type { SlicePlane } from "./renderer/slicePlane.ts";

export type CameraMode = "slice" | "arcball" | "fly";

export interface SceneView {
  readonly z: number;
  readonly t: number;
  /** The plane the slice view cuts. */
  readonly slicePlane: SlicePlane;
  /** The axis position along the slice plane's cut axis: `z` for an XY cut. */
  readonly cutIndex: number;
  /** What each layer shows, by dataset id in panel order. */
  readonly layers: ResolvedLayers;
  readonly cameraMode: CameraMode;
  /** `2d` for the slice camera, `3d` for either volume camera. */
  readonly viewMode: ViewMode;
}

/** The epochs that can move what a saved view records, and the comparison's.
 *  Annotations can move neither, so their epoch is left out. */
export interface ViewEpochs {
  readonly content: number;
  readonly layout: number;
  readonly view: number;
  readonly selection: number;
  readonly comparison: number;
}

/** A scene before its first write, and the page before it has a scene. */
const NO_SCENE_VIEW: SceneView = {
  z: 0,
  t: 0,
  slicePlane: "xy",
  cutIndex: 0,
  layers: new Map(),
  cameraMode: "slice",
  viewMode: "2d",
};

/** The raw `resolved_layers()` answer each snapshot was parsed from, so an
 *  unchanged answer keeps the snapshot's identity. */
const layersJsonOf = new WeakMap<SceneView, string>();

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
  private comparison: Comparison | null = null;
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

  /** The comparison the view shows, apart from the view so that a divider
   *  drag re-renders only what draws the comparison. */
  getComparison = (): Comparison | null => this.comparison;

  /** The epochs as last read, or null without a scene. A new object each
   *  time one of them moves. */
  getEpochs = (): ViewEpochs | null => this.epochs;

  /** Re-read the scene if it was replaced or its epochs moved, and tell the
   *  listeners. */
  sync = (): void => {
    const scene = this.getScene();
    const epochs = scene ? readEpochs(scene) : null;
    if (scene === this.scene && sameEpochs(epochs, this.epochs)) return;
    // A camera move cannot change what the layers show, so it reuses them.
    const layersJson = scene && scene === this.scene && sameLayerEpochs(epochs, this.epochs)
      ? layersJsonOf.get(this.view) ?? null
      : null;
    const comparisonMoved = scene !== this.scene || epochs?.comparison !== this.epochs?.comparison;
    this.scene = scene;
    this.epochs = epochs;
    const view = scene ? readView(scene, layersJson, this.view) : NO_SCENE_VIEW;
    if (!sameView(view, this.view)) this.view = view;
    if (comparisonMoved) this.comparison = scene ? readComparison(scene) : null;
    for (const listener of [...this.listeners]) listener();
  };
}

function sameLayerEpochs(a: ViewEpochs | null, b: ViewEpochs | null): boolean {
  if (a === null || b === null) return false;
  return a.content === b.content && a.layout === b.layout && a.selection === b.selection;
}

function readEpochs(scene: WasmScene): ViewEpochs {
  const all = JSON.parse(scene.epochs()) as ViewEpochs;
  return {
    content: all.content,
    layout: all.layout,
    view: all.view,
    selection: all.selection,
    comparison: all.comparison,
  };
}

function sameEpochs(a: ViewEpochs | null, b: ViewEpochs | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.content === b.content &&
    a.layout === b.layout &&
    a.view === b.view &&
    a.selection === b.selection &&
    a.comparison === b.comparison
  );
}

/** Read the view. `knownLayersJson` is the current answer when the caller
 *  knows the layers are unchanged; then `previous`'s parsed layers are kept. */
function readView(scene: WasmScene, knownLayersJson: string | null, previous: SceneView): SceneView {
  const mode = scene.camera_mode();
  const cameraMode: CameraMode = mode === "fly" ? "fly" : mode === "arcball" ? "arcball" : "slice";
  const layersJson = knownLayersJson ?? scene.resolved_layers();
  const layers = layersJson === layersJsonOf.get(previous)
    ? previous.layers
    : parseResolvedLayers(layersJson);
  const view: SceneView = {
    z: scene.z(),
    t: scene.t(),
    slicePlane: scene.slice_plane() as SlicePlane,
    cutIndex: scene.cut_index(),
    layers,
    cameraMode,
    viewMode: cameraMode === "slice" ? "2d" : "3d",
  };
  layersJsonOf.set(view, layersJson);
  return view;
}

function sameView(a: SceneView, b: SceneView): boolean {
  return (
    a.z === b.z &&
    a.t === b.t &&
    a.slicePlane === b.slicePlane &&
    a.cutIndex === b.cutIndex &&
    a.layers === b.layers &&
    a.cameraMode === b.cameraMode
  );
}
