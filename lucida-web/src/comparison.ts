/**
 * Two datasets compared in one view, as the scene holds it: split by a
 * divider (swipe) or shown in turn (blink). lucida-core decides whether a
 * pair lines up, what of the view's width each one shows, and which other
 * layers it sets aside; the web turns that into pixels, controls and copy.
 */
import type { WasmScene } from "lucida-core";
import { noteSceneWrite } from "./sceneStore.ts";
import type { InvalidationSink } from "./invalidation.ts";
import type { PixelRect } from "./renderer/layerBatches.ts";
import type { ResolvedLayers } from "./resolvedLayers.ts";

export type CompareMode = "swipe" | "blink";

export interface Comparison {
  /** Left of the divider, and what a blink shows first. */
  readonly a: string;
  /** Right of the divider. */
  readonly b: string;
  readonly mode: CompareMode;
  /** The divider, as a fraction of the view's width from its left edge. */
  readonly divider: number;
  /** What a blink shows. */
  readonly showing: "a" | "b";
}

/** Whether two datasets line up in physical space, from `Scene::line_up`. */
export type LineUp =
  | { verdict: "yes" }
  | { verdict: "same" }
  | { verdict: "apart" }
  | { verdict: "missing"; datasets: string[] }
  | { verdict: "no_physical_scale"; datasets: string[] };

export type ComparisonScene = Pick<
  WasmScene,
  | "comparison"
  | "comparison_span"
  | "datasets_line_up"
  | "compare"
  | "end_comparison"
  | "set_comparison_mode"
  | "set_comparison_divider"
  | "flip_comparison"
>;

export function readComparison(scene: Pick<WasmScene, "comparison">): Comparison | null {
  return JSON.parse(scene.comparison()) as Comparison | null;
}

export function readLineUp(scene: Pick<WasmScene, "datasets_line_up">, a: string, b: string): LineUp {
  return JSON.parse(scene.datasets_line_up(a, b)) as LineUp;
}

/** Why `a` can't be compared with `b`, in a sentence, or null when it can. */
export function lineUpReason(lineUp: LineUp, nameOf: (id: string) => string): string | null {
  const names = (ids: string[]) => ids.map(nameOf).join(" and ");
  switch (lineUp.verdict) {
    case "yes":
      return null;
    case "same":
      return "A layer can't be compared with itself.";
    case "apart":
      return "They don't overlap in physical space.";
    case "missing":
      return `${names(lineUp.datasets)} ${lineUp.datasets.length === 1 ? "has" : "have"} no image yet.`;
    case "no_physical_scale":
      return `${names(lineUp.datasets)} ${lineUp.datasets.length === 1 ? "has" : "have"} no physical scale to line up by.`;
  }
}

/**
 * Where a dataset may show on a target of `width` × `height` pixels under the
 * view's comparison: everywhere (null) when there is none, nowhere
 * (`"hidden"`), or a column of the target. A layer the comparison sets aside
 * resolves as not visible, so it never gets this far.
 */
export type ComparisonClip = PixelRect | null | "hidden";

export function comparisonClip(
  scene: Pick<WasmScene, "comparison_span">,
  view: number,
  datasetId: string,
  width: number,
  height: number,
): ComparisonClip {
  const span = scene.comparison_span(view, datasetId);
  if (span.length < 2) return null;
  // Both sides round the divider alike, so they meet on one pixel boundary
  // with no column drawn twice or left out.
  const from = Math.round(span[0] * width);
  const to = Math.round(span[1] * width);
  return to > from ? [from, 0, to - from, height] : "hidden";
}

/** What the compare bar says of the layers the comparison sets aside, or null for none. */
export function setAsideNote(layers: ResolvedLayers): string | null {
  let count = 0;
  for (const layer of layers.values()) if (layer.set_aside) count++;
  if (count === 0) return null;
  return `${count} other ${count === 1 ? "layer" : "layers"} hidden while comparing`;
}

/** The pixels two rects share, or null when they share none. */
export function intersectRects(a: PixelRect, b: PixelRect): [number, number, number, number] | null {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/**
 * The view's comparison controls: each writes the scene, tells the scene
 * store, and draws the next frame under the `compare` input. None of them
 * touches what is wanted, so the planner re-reads nothing.
 */
export interface ComparisonActions {
  /** The comparison the view shows now, read from the scene. */
  current(): Comparison | null;
  /** Compare `a` with `b` in `mode`; the verdict says why not when it isn't `yes`. */
  start(a: string, b: string, mode: CompareMode): LineUp;
  end(): void;
  setMode(mode: CompareMode): void;
  setDivider(at: number): void;
  flip(): void;
}

export function comparisonActions(
  scene: () => ComparisonScene | null,
  loop: () => InvalidationSink | null | undefined,
): ComparisonActions {
  const write = (edit: (scene: ComparisonScene) => void) => {
    const current = scene();
    if (!current) return;
    edit(current);
    loop()?.markInput("compare");
    noteSceneWrite();
  };
  return {
    current() {
      const current = scene();
      return current ? readComparison(current) : null;
    },
    start(a, b, mode) {
      const current = scene();
      if (!current) return { verdict: "missing", datasets: [a, b] };
      const verdict = JSON.parse(current.compare(a, b, mode)) as LineUp;
      if (verdict.verdict === "yes") write(() => {});
      return verdict;
    },
    end: () => write((s) => s.end_comparison()),
    setMode: (mode) => write((s) => s.set_comparison_mode(mode)),
    setDivider: (at) => write((s) => s.set_comparison_divider(at)),
    flip: () => write((s) => s.flip_comparison()),
  };
}
