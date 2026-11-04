import { useEffect, useRef, useState } from "react";
import { WasmScene, set_debug_categories } from "lucida-core";
import { getEnabledCategories, onDebugCategoriesChanged } from "../debug/logging.ts";
import { initWasmOnce } from "../wasmInit.ts";

export function useWasmScene() {
  const [wasmReady, setWasmReady] = useState(false);
  /** Set when wasm init rejects, so a failed boot shows an error instead of a
   *  blank shell. Never set on the same mount as `wasmReady`. */
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  // Handlers read the ref to avoid stale closures. The render-phase write is
  // idempotent.
  const wasmSceneRef = useRef<WasmScene | null>(null);
  // eslint-disable-next-line react-hooks/refs
  wasmSceneRef.current = wasmScene;

  useEffect(() => {
    // `initWasmOnce` shares one instantiation across concurrent StrictMode
    // mounts and later remounts, so every `WasmScene` follows that single
    // resolved init.
    let cancelled = false;
    let unsub: (() => void) | null = null;
    initWasmOnce()
      .then(() => {
        if (cancelled) return;
        // Subscribe so later panel toggles reach WASM without a reload.
        set_debug_categories(getEnabledCategories().join(","));
        unsub = onDebugCategoriesChanged((cats) => {
          set_debug_categories(cats.join(","));
        });
        setWasmReady(true);
      })
      .catch((e: unknown) => {
        console.error("wasm module initialization failed:", e);
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setWasmError(`Viewer failed to start: ${message}. Reload the page to try again.`);
      });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  function ensureScene(): WasmScene {
    let scene = wasmSceneRef.current;
    if (!scene) {
      scene = new WasmScene(800, 600);
      wasmSceneRef.current = scene;
    }
    return scene;
  }

  return { wasmReady, wasmError, wasmScene, wasmSceneRef, setWasmScene, ensureScene };
}
