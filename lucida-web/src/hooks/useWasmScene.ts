import { useEffect, useRef, useState } from "react";
import init, { WasmScene } from "lucida-core";

export function useWasmScene() {
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  const wasmSceneRef = useRef<WasmScene | null>(null);
  wasmSceneRef.current = wasmScene;

  useEffect(() => {
    init().then(() => setWasmReady(true));
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
