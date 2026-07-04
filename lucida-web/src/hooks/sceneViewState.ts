import type { WasmScene } from "lucida-core";
import type { ViewMode } from "../types.ts";

/**
 * Plain value setters (not React dispatchers) so non-React owners — the
 * session controller — can supply them directly; React `setState` functions
 * are assignable as-is.
 */
export interface SceneViewStateSetters {
  setZ: (z: number) => void;
  setC: (c: number) => void;
  setT: (t: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setMultiChannel: (multiChannel: boolean) => void;
}

export function syncSceneViewState(scene: WasmScene, setters: SceneViewStateSetters): void {
  setters.setZ(scene.z());
  setters.setT(scene.t());
  setters.setC(scene.c());
  setters.setViewMode(scene.camera_mode() !== "slice" ? "3d" : "2d");
  setters.setMultiChannel(scene.multi_channel());
}
