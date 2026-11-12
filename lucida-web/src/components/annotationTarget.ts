/**
 * The layer a mark placed in a view lands on. Each view shows its own
 * datasets, so a mark goes on one the view draws under the pointer and never
 * on the selected layer when another view shows it: the selected layer where
 * this view draws it there, so the layer panel still picks between layers
 * that overlap, or else the topmost one.
 */
import type { WasmScene } from "lucida-core";
import { toast } from "../ui/toastQueue.ts";
import type { ClientPoint, ViewSurface } from "./cameraProjection.ts";

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

/** Say that a press placed no mark, since this view lays the layer under it
 * out apart from its frame, as a side view of a collection does. */
export function sayNoMarksInThisView(): void {
  toast({
    title: "Can't annotate this layer here",
    description: "Marks on a collection go in an XY view.",
    tone: "warning",
  });
}

/** Say that a press placed no mark, since the view draws no layer under it. */
export function sayNoLayerToAnnotate(): void {
  toast({
    title: "Nothing here to annotate",
    description: "A mark goes on a layer this view shows under the pointer.",
    tone: "warning",
  });
}
