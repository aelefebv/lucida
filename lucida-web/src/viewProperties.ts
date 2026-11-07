/**
 * Test support: the web half of the view property suite in
 * `lucida-core/src/view_properties`. It reads the same fixtures and measures a
 * real `WasmScene` by the same rules, for the view producers whose logic lives
 * in the web client: the saved-view applier, the Explore panel, and the 2D/3D
 * switch.
 *
 * The rules: a framed dataset lies inside the viewport and fills at least half
 * of the limiting axis, and a view shows the dataset at the same CSS size at
 * device pixel ratio 1 and 2. The scene's viewport is the canvas in device
 * pixels, as the render loop sets it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initSync, WasmScene } from "lucida-core";
import {
  resolveDatasetManifest,
  type DatasetManifest,
  type DatasetManifestWire,
} from "./manifestTypes.ts";

let loaded = false;

/** Instantiate the built wasm from disk; vitest runs from `lucida-web`. */
export function loadWasm(): void {
  if (loaded) return;
  initSync({ module: readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm")) });
  loaded = true;
}

type Shape = [number, number, number, number, number];

/** A `DatasetOpened` as the server sends it. Only the manifest is typed. */
export interface DatasetOpenedJson {
  manifest: DatasetManifestWire;
  [key: string]: unknown;
}

export interface ViewFixture {
  name: string;
  opened: DatasetOpenedJson;
}

/** The core suite's fixtures, which it locks against this file. */
export const FIXTURES: readonly ViewFixture[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "../fixtures/view-properties/datasets.json"), "utf8"),
);

export function fixture(name: string): ViewFixture {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no view fixture named ${name}`);
  return found;
}

/** `fixture` under another dataset id, so one scene can hold several. */
export function renamed(f: ViewFixture, datasetId: string): DatasetOpenedJson {
  return { ...f.opened, manifest: { ...f.opened.manifest, dataset_id: datasetId } };
}

export function datasetId(f: ViewFixture): string {
  return f.opened.manifest.dataset_id;
}

/** The manifest as the client holds it, with shared multiscales resolved. */
export function manifest(f: ViewFixture): DatasetManifest {
  return resolveDatasetManifest(f.opened.manifest);
}

/** `[T, C, Z, Y, X]` of the first image at level 0. */
export function dims(f: ViewFixture): Shape {
  return manifest(f).images[0].multiscale.levels[0].shape as Shape;
}

export interface Viewport {
  name: string;
  /** The canvas in CSS pixels. */
  css: [number, number];
}

export const VIEWPORTS: readonly Viewport[] = [
  { name: "landscape", css: [1280, 800] },
  { name: "portrait", css: [390, 844] },
];

export const PIXEL_RATIOS = [1, 2] as const;

export function newScene(vp: Viewport, dpr: number): WasmScene {
  return new WasmScene(vp.css[0] * dpr, vp.css[1] * dpr);
}

/** The server's `dataset_opened` broadcast for `opened`, applied to `scene`. */
export function openIn(scene: WasmScene, opened: DatasetOpenedJson): void {
  scene.apply_command(JSON.stringify({ type: "dataset_opened", ...opened }));
}

/** A page that joined once the datasets were open: the document arrives in
 *  the workspace snapshot and nothing fits the camera. */
export function joinedScene(vp: Viewport, dpr: number, opened: DatasetOpenedJson[]): WasmScene {
  const scene = newScene(vp, dpr);
  const manifests = Object.fromEntries(opened.map((o) => [o.manifest.dataset_id, o.manifest]));
  scene.load_document(JSON.stringify({ manifests }));
  return scene;
}

/** The opener's page: the dataset opens and the camera fits it in `mode`. */
export function openedScene(
  f: ViewFixture,
  vp: Viewport,
  dpr: number,
  mode: "slice" | "arcball",
): WasmScene {
  const scene = newScene(vp, dpr);
  if (mode === "arcball") scene.apply_command(JSON.stringify({ type: "set_mode_arcball" }));
  openIn(scene, f.opened);
  scene.fit_camera_to_dataset_bounds(datasetId(f));
  return scene;
}

interface ScreenRect {
  min: [number, number];
  max: [number, number];
}

/** Where the dataset's bounding box lands, in device pixels: every corner of
 *  its fit bounds through the active camera. */
function screenRect(scene: WasmScene, id: string): ScreenRect | string {
  const b = scene.dataset_fit_bounds(id);
  if (b.length !== 6) return "the dataset has no bounds";
  const rect: ScreenRect = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (let corner = 0; corner < 8; corner++) {
    const pick = (axis: number) => ((corner >> axis) & 1 ? b[axis + 3] : b[axis]);
    const p = scene.project_to_screen(pick(0), pick(1), pick(2));
    if (p.length !== 2) return "part of the dataset is behind the camera";
    rect.min = [Math.min(rect.min[0], p[0]), Math.min(rect.min[1], p[1])];
    rect.max = [Math.max(rect.max[0], p[0]), Math.max(rect.max[1], p[1])];
  }
  return rect;
}

const FILL_FLOOR = 0.5;
const EDGE_SLACK_PX = 1;
const CSS_SIZE_TOLERANCE = 0.01;

function viewport(scene: WasmScene): [number, number] {
  const camera = (JSON.parse(scene.export_presence()) as { camera: { viewport: [number, number] } })
    .camera;
  return camera.viewport;
}

/** Why the dataset is not framed in `scene`, or null when it is. */
export function notFramed(scene: WasmScene, id: string): string | null {
  const rect = screenRect(scene, id);
  if (typeof rect === "string") return rect;
  const [w, h] = viewport(scene);
  const inside =
    rect.min[0] >= -EDGE_SLACK_PX &&
    rect.min[1] >= -EDGE_SLACK_PX &&
    rect.max[0] <= w + EDGE_SLACK_PX &&
    rect.max[1] <= h + EDGE_SLACK_PX;
  const span = (n: number) => n.toFixed(0);
  if (!inside) {
    return `clipped: spans [${rect.min.map(span)}]..[${rect.max.map(span)}] in ${w}x${h}`;
  }
  const fill = Math.max((rect.max[0] - rect.min[0]) / w, (rect.max[1] - rect.min[1]) / h);
  if (fill < FILL_FLOOR) return `too small: fills ${fill.toFixed(2)} of the limiting axis`;
  return null;
}

/** The dataset's on-screen size in CSS pixels. */
export function cssSize(scene: WasmScene, id: string, dpr: number): [number, number] {
  const rect = screenRect(scene, id);
  if (typeof rect === "string") throw new Error(rect);
  return [(rect.max[0] - rect.min[0]) / dpr, (rect.max[1] - rect.min[1]) / dpr];
}

/** Why two CSS sizes differ, or null when they match. */
export function cssSizesDiffer(a: [number, number], b: [number, number]): string | null {
  const differs = [0, 1].some(
    (axis) => Math.abs(a[axis] - b[axis]) / Math.max(Math.abs(a[axis]), Math.abs(b[axis])) > CSS_SIZE_TOLERANCE,
  );
  const size = (s: [number, number]) => s.map((n) => n.toFixed(0)).join("x");
  return differs ? `${size(a)} CSS px against ${size(b)}` : null;
}

/** Collects the cases that break one property, so a failure names them all. */
export class PropertyReport {
  private failures: string[] = [];
  private cases = 0;

  check(label: string, failure: string | null): void {
    this.cases++;
    if (failure) this.failures.push(`${label}: ${failure}`);
  }

  /** Throws, naming every failing case, unless the property held in all. */
  assertHolds(): void {
    if (this.cases === 0) throw new Error("no cases ran");
    if (this.failures.length > 0) {
      throw new Error(
        `fails in ${this.failures.length} of ${this.cases} cases:\n  ${this.failures.join("\n  ")}`,
      );
    }
  }
}
