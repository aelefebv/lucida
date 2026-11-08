import { useSyncExternalStore } from "react";
import type { SceneStore, SceneView } from "../sceneStore.ts";

/** Read the scene's view state, re-rendering only when it changes. */
export function useSceneView(store: SceneStore): SceneView {
  return useSyncExternalStore(store.subscribe, store.getView, store.getView);
}
