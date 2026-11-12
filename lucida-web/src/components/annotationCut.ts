/**
 * Standing the active view where a mark lies: on the plane of its dataset that
 * holds the mark's anchor, along the axis the view steps through, which is the
 * one its slice plane cuts, or Z in a volume view.
 */
import type { WasmScene } from "lucida-core";
import type { SetXCommand, SetYCommand, SetZCommand } from "../commands.ts";
import type { SpatialAxis } from "../renderer/slicePlane.ts";
import type { Annotation } from "./annotationDocument.ts";
import { pinStart } from "./annotationGeometry.ts";

/** Mirrors `lucida_core::scene::AnnotationCut`. */
interface AnnotationCut {
  axis: SpatialAxis;
  position: number;
}

type CutScene = Pick<WasmScene, "active_view" | "annotation_cut" | "z" | "cut_index">;

/** The command that stands the active view on the plane `pin` lies on, or
 * null where it stands there already. */
export function annotationCutCommand(
  scene: CutScene,
  datasetId: string,
  pin: Annotation,
): SetZCommand | SetYCommand | SetXCommand | null {
  const view = scene.active_view();
  const [x, y, z] = pinStart(pin);
  const cut = JSON.parse(scene.annotation_cut(view, datasetId, x, y, z, pin.anchor ?? undefined)) as AnnotationCut | null;
  if (!cut) return null;
  // A volume view steps along Z, the slice view's cut along its own axis.
  const at = cut.axis === "z" ? scene.z() : scene.cut_index(view);
  if (cut.position === at) return null;
  switch (cut.axis) {
    case "z":
      return { type: "set_z", z: cut.position };
    case "y":
      return { type: "set_y", y: cut.position };
    case "x":
      return { type: "set_x", x: cut.position };
  }
}
