import { useCallback, useEffect, useRef, useState } from "react";
import { WasmScene, set_debug_categories } from "lucida-core";
import { getEnabledCategories, onDebugCategoriesChanged } from "../debug/logging.ts";
import { initWasmOnce } from "../wasmInit.ts";

export function useWasmScene() {
  const [wasmReady, setWasmReady] = useState(false);
  /** Human-readable boot failure, set when the wasm initialization
   *  rejects. Without it a failed boot is a permanently blank shell with
   *  nothing but a console line; the app renders this like any other
   *  top-level error. Never set on the same mount as `wasmReady`. */
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [wasmAttempt, setWasmAttempt] = useState(0);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  // Ref mirror of the wasmScene state — handlers and downstream
  // hooks read .current to avoid stale closures over `wasmScene`.
  // The mirror update is render-phase and idempotent.
  const wasmSceneRef = useRef<WasmScene | null>(null);
  // eslint-disable-next-line react-hooks/refs
  wasmSceneRef.current = wasmScene;

  useEffect(() => {
    // `initWasmOnce` shares one instantiation across concurrent mounts (dev
    // StrictMode double-mounts this effect while the first init is still in
    // flight) and across remounts after completion. `wasmReady` — and with
    // it every `WasmScene` construction — only ever follows that single
    // resolved initialization.
    let cancelled = false;
    let unsub: (() => void) | null = null;
    initWasmOnce()
      .then(() => {
        if (cancelled) return;
        // Push initial enabled categories into WASM, then subscribe so
        // future panel toggles propagate without a reload.
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
        setWasmError(`Viewer failed to start: ${message}.`);
      });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [wasmAttempt]);

  const retryWasm = useCallback(() => {
    setWasmError(null);
    setWasmAttempt((attempt) => attempt + 1);
  }, []);

  // This hook is the factory/owner of the wasm-bindgen scene, so it also owns
  // deterministic destruction. Clearing the ref before `free()` makes cleanup
  // idempotent under StrictMode's mount/cleanup replay and prevents any late
  // callback from observing an already-freed scene.
  useEffect(() => () => {
    const scene = wasmSceneRef.current;
    wasmSceneRef.current = null;
    scene?.free();
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

  return {
    wasmReady,
    wasmError,
    retryWasm,
    wasmScene,
    wasmSceneRef,
    setWasmScene,
    ensureScene,
  };
}
