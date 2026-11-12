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
import { readViewComparison, type Comparison } from "./comparison.ts";
import { parseResolvedLayers, type ResolvedLayers } from "./resolvedLayers.ts";
import type { ViewMode } from "./types.ts";
import type { SlicePlane } from "./renderer/slicePlane.ts";
import type { ViewLayoutName } from "./commands.ts";
import { readViewLinks, type ViewLinks } from "./viewLinks.ts";

export type CameraMode = "slice" | "arcball" | "fly";

/** One view as the page lays it out. */
export interface ViewPane {
  readonly id: number;
  /** What it shows: every dataset, or these alone. */
  readonly shows: "all" | readonly string[];
  /** The datasets it draws, in layer order. */
  readonly draws: readonly string[];
  /** `[x, y, width, height]` in fractions of the canvas from its top-left corner. */
  readonly rect: readonly [number, number, number, number];
  readonly cameraMode: CameraMode;
  /** Its timepoint, apart from the active view's while time is not linked. */
  readonly t: number;
  /** Whether commands steer it. */
  readonly active: boolean;
  /** The layers its comparison sets aside, in layer order. */
  readonly setAside: readonly string[];
}

export interface SceneView {
  /** The active view's position on its Z grid, from 0. */
  readonly z: number;
  /** The place along Z it cuts, in the scene frame. */
  readonly zPlace: number;
  readonly t: number;
  /** The plane the slice view cuts. */
  readonly slicePlane: SlicePlane;
  /** The axis position along the slice plane's cut axis: `z` for an XY cut. */
  readonly cutIndex: number;
  /** The place it cuts as a physical coordinate, with the characters the
   *  widest one on its grid takes; null when the scene measures no length. */
  readonly cutPlace: PlaceLabel | null;
  /** What each layer shows, by dataset id in panel order. */
  readonly layers: ResolvedLayers;
  readonly cameraMode: CameraMode;
  /** `2d` for the slice camera, `3d` for either volume camera. */
  readonly viewMode: ViewMode;
  /** Every view on the canvas, in the layout's order. The fields above are the active view's. */
  readonly views: readonly ViewPane[];
  /** How the canvas divides among the views. */
  readonly layout: ViewLayoutName;
  /** The view shown alone across the canvas, if one is. */
  readonly maximized: number | null;
  /** How the two views link, or null with one view. */
  readonly links: ViewLinks | null;
}

/** A place in the scene frame as a physical coordinate, such as `48.5 µm`. */
export interface PlaceLabel {
  readonly label: string;
  /** The characters the widest coordinate on the same grid takes. */
  readonly width: number;
}

/** The epochs that can move what a saved view records, the comparison's
 *  and the links'. Annotations can move none of them, so their epoch is
 *  left out. */
export interface ViewEpochs {
  readonly content: number;
  readonly layout: number;
  readonly view: number;
  readonly selection: number;
  readonly comparison: number;
  readonly links: number;
}

/** A scene before its first write, and the page before it has a scene. */
const NO_SCENE_VIEW: SceneView = {
  z: 0,
  zPlace: 0.5,
  t: 0,
  slicePlane: "xy",
  cutIndex: 0,
  cutPlace: null,
  layers: new Map(),
  cameraMode: "slice",
  viewMode: "2d",
  views: [{ id: 0, shows: "all", draws: [], rect: [0, 0, 1, 1], cameraMode: "slice", t: 0, active: true, setAside: [] }],
  layout: "single",
  maximized: null,
  links: null,
};

const NO_COMPARISONS: ReadonlyMap<number, Comparison> = new Map();

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
  private comparisons: ReadonlyMap<number, Comparison> = NO_COMPARISONS;
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

  /** The comparison each view on the canvas shows, by view id, apart from
   *  the view so that a divider drag re-renders only what draws a comparison. */
  getComparisons = (): ReadonlyMap<number, Comparison> => this.comparisons;

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
    // A view that leaves the canvas or comes back takes its comparison with it.
    const viewsMoved = view.views !== this.view.views;
    if (!sameView(view, this.view)) this.view = view;
    if (comparisonMoved || viewsMoved) {
      this.comparisons = scene ? readComparisons(scene, this.view.views) : NO_COMPARISONS;
    }
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
    links: all.links,
  };
}

function sameEpochs(a: ViewEpochs | null, b: ViewEpochs | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.content === b.content &&
    a.layout === b.layout &&
    a.view === b.view &&
    a.selection === b.selection &&
    a.comparison === b.comparison &&
    a.links === b.links
  );
}

/** Read the view. `knownLayersJson` is the current answer when the caller
 *  knows the layers are unchanged; then `previous`'s parsed layers are kept. */
function readView(scene: WasmScene, knownLayersJson: string | null, previous: SceneView): SceneView {
  const mode = scene.camera_mode();
  const cameraMode: CameraMode = mode === "fly" ? "fly" : mode === "arcball" ? "arcball" : "slice";
  const layersJson = knownLayersJson ?? scene.resolved_layers(scene.active_view());
  const layers = layersJson === layersJsonOf.get(previous)
    ? previous.layers
    : parseResolvedLayers(layersJson);
  const view: SceneView = {
    z: scene.z(),
    zPlace: scene.z_place(),
    t: scene.t(),
    slicePlane: scene.slice_plane(scene.active_view()) as SlicePlane,
    cutIndex: scene.cut_index(scene.active_view()),
    cutPlace: readCutPlace(scene, previous.cutPlace),
    layers,
    cameraMode,
    viewMode: cameraMode === "slice" ? "2d" : "3d",
    views: readViews(scene, previous.views),
    layout: (scene.view_layout() || "single") as ViewLayoutName,
    maximized: scene.maximized_view() ?? null,
    links: readLinks(scene, previous.links),
  };
  layersJsonOf.set(view, layersJson);
  return view;
}

/** Every view, keeping `previous` while nothing in it changed. */
function readViews(scene: WasmScene, previous: readonly ViewPane[]): readonly ViewPane[] {
  const active = scene.active_view();
  const views = Array.from(scene.view_ids(), (id): ViewPane => {
    const [x, y, width, height] = scene.view_rect(id);
    const shows = JSON.parse(scene.view_datasets(id)) as "all" | { only: string[] } | null;
    return {
      id,
      shows: shows === null || shows === "all" ? "all" : shows.only,
      draws: JSON.parse(scene.drawn_datasets(id)) as string[],
      rect: [x, y, width, height],
      cameraMode: (scene.view_camera_mode(id) || "slice") as CameraMode,
      t: scene.view_t(id),
      active: id === active,
      setAside: JSON.parse(scene.set_aside(id)) as string[],
    };
  });
  return JSON.stringify(views) === JSON.stringify(previous) ? previous : views;
}

/** The active view's cut as a physical coordinate, keeping `previous` while
 *  it reads the same. */
function readCutPlace(scene: WasmScene, previous: PlaceLabel | null): PlaceLabel | null {
  const reading = JSON.parse(scene.cut_reading(scene.active_view())) as { length?: string; length_width?: number };
  if (reading.length === undefined) return null;
  const width = reading.length_width ?? reading.length.length;
  return previous?.label === reading.length && previous.width === width ? previous : { label: reading.length, width };
}

/** The links, keeping `previous` while nothing in them changed. Which
 *  properties can link follows the cameras, so they are read on every move. */
function readLinks(scene: WasmScene, previous: ViewLinks | null): ViewLinks | null {
  const links = readViewLinks(scene);
  return JSON.stringify(links) === JSON.stringify(previous) ? previous : links;
}

/** The comparison of each of `views` that shows one. */
function readComparisons(scene: WasmScene, views: readonly ViewPane[]): ReadonlyMap<number, Comparison> {
  const comparisons = new Map<number, Comparison>();
  for (const view of views) {
    const comparison = readViewComparison(scene, view.id);
    if (comparison) comparisons.set(view.id, comparison);
  }
  return comparisons.size > 0 ? comparisons : NO_COMPARISONS;
}

function sameView(a: SceneView, b: SceneView): boolean {
  return (
    a.z === b.z &&
    a.zPlace === b.zPlace &&
    a.t === b.t &&
    a.slicePlane === b.slicePlane &&
    a.cutIndex === b.cutIndex &&
    a.cutPlace === b.cutPlace &&
    a.layers === b.layers &&
    a.cameraMode === b.cameraMode &&
    a.views === b.views &&
    a.layout === b.layout &&
    a.maximized === b.maximized &&
    a.links === b.links
  );
}
