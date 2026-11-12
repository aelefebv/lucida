/**
 * The layer a mark placed in a view lands on. Each view shows its own
 * datasets, so a mark goes on one the view draws under the pointer and never
 * on the selected layer when another view shows it: the selected layer where
 * this view draws it there, so the layer panel still picks between layers
 * that overlap, or else the topmost one.
 */
import type { WasmScene } from "lucida-core";
import { toast } from "../ui/toastQueue.ts";
import { pickFramePoint, type ClientPoint, type ViewSurface } from "./cameraProjection.ts";
import type { AnnotationPlacement } from "./useAnnotationEditing.ts";

/** The layer for a mark placed at `at` in `surface`'s view, or null where the view draws none. */
export function annotationTarget(
  scene: Pick<WasmScene, "layers_at">,
  { view, element }: ViewSurface,
  at: ClientPoint,
  selected: string | null,
): string | null {
  const { clientWidth: width, clientHeight: height } = element;
  if (!(width > 0 && height > 0)) return null;
  const rect = element.getBoundingClientRect();
  const under = JSON.parse(
    scene.layers_at(view, (at.clientX - rect.left) / width, (at.clientY - rect.top) / height),
  ) as string[];
  return selected !== null && under.includes(selected) ? selected : (under[0] ?? null);
}

/** Where a point placed at `at` in `surface`'s view goes: on the layer
 * {@link annotationTarget} picks, at the point of its frame there. Null where
 * the view draws no layer under it. */
export function annotationPlacement(
  scene: Pick<WasmScene, "layers_at" | "pick_annotation_voxel">,
  surface: ViewSurface,
  at: ClientPoint,
  selected: string | null,
): AnnotationPlacement | null {
  const datasetId = annotationTarget(scene, surface, at, selected);
  const point = datasetId === null ? null : pickFramePoint(scene, surface, datasetId, at);
  return datasetId !== null && point ? { datasetId, position: [point[0], point[1]], z: point[2] } : null;
}

/** Say that a press placed no mark, since the view draws no layer under it. */
export function sayNoLayerToAnnotate(): void {
  toast({
    title: "Nothing here to annotate",
    description: "A mark goes on a layer this view shows under the pointer.",
    tone: "warning",
  });
}
