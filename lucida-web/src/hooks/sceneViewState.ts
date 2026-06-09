import type { WasmScene } from "lucida-core";
import type { Dispatch, SetStateAction } from "react";
import type { ViewMode } from "../types.ts";

export interface SceneViewStateSetters {
  setZ: Dispatch<SetStateAction<number>>;
  setC: Dispatch<SetStateAction<number>>;
  setT: Dispatch<SetStateAction<number>>;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  setMultiChannel: Dispatch<SetStateAction<boolean>>;
}

export function syncSceneViewState(scene: WasmScene, setters: SceneViewStateSetters): void {
  setters.setZ(scene.z());
  setters.setT(scene.t());
  setters.setC(scene.c());
  setters.setViewMode(scene.camera_mode() !== "slice" ? "3d" : "2d");
  setters.setMultiChannel(scene.multi_channel());
}
