/**
 * Pure resolution of "what label is under the cursor, and should a tooltip
 * show?" — the decision the SliceViewer's debounced hover-settle makes, lifted
 * out of the component so it is unit-testable without a DOM / RenderLoop / GPU
 * worker.
 *
 * Given the scene accessors, an async label-value sampler (the worker round-trip
 * via `RenderClient.sampleLabelValue`), and the cursor position, this returns the
 * tooltip content or `null`. It encodes the slice's gating rules:
 *
 *   - a tooltip shows **iff** a *shown* label overlay that is *effectively
 *     visible* (`visible === true && opacity > 0`) reports a **non-zero** id at
 *     the picked voxel;
 *   - `value === 0` (background), a hidden label, or `opacity === 0` → no tooltip;
 *   - the pick reads the finest resident level (handled worker-side), so a fused
 *     coarse id is never reported;
 *   - the ray missing the volume → no tooltip.
 *
 * The top-most effectively-visible label (highest label index — last drawn)
 * wins when several overlap.
 */

import type { WasmScene } from "lucida-core";
import type { LabelOverlayView } from "../manifestTypes.ts";
import { labelPropertyRows, type LabelTooltipRow } from "./labelTooltip.ts";

/** Resolved tooltip content (position is added by the caller). */
export interface ResolvedLabelHover {
  name: string;
  value: number;
  rows: LabelTooltipRow[];
}

/** Async sampler signature — normally `RenderClient.sampleLabelValue` bound with
 * the picked voxel + primary shape; injectable so tests need no worker. */
export type LabelValueSampler = (
  datasetId: string,
  labelIndex: number,
  voxel: [number, number, number],
  primaryShape: [number, number, number],
) => Promise<number>;

/** The subset of `WasmScene` this resolution reads (keeps tests to a tiny mock). */
export interface HoverScene {
  label_overlays(datasetId: string): string;
  pick_annotation_voxel(datasetId: string, screenX: number, screenY: number): Float64Array | number[];
  dataset_volume_shape(datasetId: string): Uint32Array | number[];
  label_property(datasetId: string, labelIndex: number, value: number): string;
}

/**
 * Resolve the label hover for `datasetId` at physical-pixel screen coords
 * `(screenX, screenY)`. Returns the tooltip content, or `null` when nothing
 * should be shown.
 */
export async function resolveLabelHover(
  scene: HoverScene,
  sample: LabelValueSampler,
  datasetId: string,
  screenX: number,
  screenY: number,
): Promise<ResolvedLabelHover | null> {
  // Which labels are shown AND effectively visible? A hidden or fully
  // transparent label never yields a tooltip.
  let overlays: LabelOverlayView[];
  try {
    overlays = JSON.parse(scene.label_overlays(datasetId)) as LabelOverlayView[];
  } catch {
    return null;
  }
  const visibleLabels = overlays
    .filter((o) => o.visible === true && o.opacity > 0)
    .sort((a, b) => b.index - a.index); // top-most (highest index) first

  if (visibleLabels.length === 0) return null;

  // Pick the voxel under the cursor (primary member level-0 frame). Empty → miss.
  const voxelArr = scene.pick_annotation_voxel(datasetId, screenX, screenY);
  if (!voxelArr || voxelArr.length < 3) return null;
  const voxel: [number, number, number] = [voxelArr[0], voxelArr[1], voxelArr[2]];

  // Primary shape [X, Y, Z] (dataset_volume_shape returns [Z, Y, X]).
  const shapeArr = scene.dataset_volume_shape(datasetId);
  const primaryShape: [number, number, number] = [
    shapeArr[2] ?? 1,
    shapeArr[1] ?? 1,
    shapeArr[0] ?? 1,
  ];

  // First effectively-visible label with a non-zero id under the cursor wins.
  for (const label of visibleLabels) {
    const value = await sample(datasetId, label.index, voxel, primaryShape);
    if (value === 0) continue; // background under this label → try the next

    let rows: LabelTooltipRow[] = [];
    try {
      const parsed = JSON.parse(scene.label_property(datasetId, label.index, value)) as
        | Record<string, unknown>
        | null;
      rows = labelPropertyRows(parsed);
    } catch {
      rows = [];
    }
    return { name: label.name, value, rows };
  }
  return null;
}

/** Narrow a real `WasmScene` to the {@link HoverScene} surface (identity at
 * runtime; a type-only adapter so callers pass the full scene). */
export function asHoverScene(scene: WasmScene): HoverScene {
  return scene as unknown as HoverScene;
}
