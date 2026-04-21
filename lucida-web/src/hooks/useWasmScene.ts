import { useEffect, useRef, useState } from "react";
import init, { WasmScene, set_debug_categories } from "lucida-core";
import { getEnabledCategories, onDebugCategoriesChanged } from "../debug/logging.ts";

export function useWasmScene() {
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  const wasmSceneRef = useRef<WasmScene | null>(null);
  wasmSceneRef.current = wasmScene;

  useEffect(() => {
    let unsub: (() => void) | null = null;
    init().then(() => {
      // Push initial enabled categories into WASM, then subscribe so
      // future panel toggles propagate without a reload.
      set_debug_categories(getEnabledCategories().join(","));
      unsub = onDebugCategoriesChanged((cats) => {
        set_debug_categories(cats.join(","));
      });
      setWasmReady(true);
    });
    return () => {
      unsub?.();
    };
  }, []);

  /** Create a WasmScene if one doesn't exist yet, and return it. */
  function ensureScene(): WasmScene {
    let scene = wasmSceneRef.current;
    if (!scene) {
      scene = new WasmScene(800, 600);
      wasmSceneRef.current = scene;
    }
    return scene;
  }

  return { wasmReady, wasmScene, wasmSceneRef, setWasmScene, ensureScene };
}
