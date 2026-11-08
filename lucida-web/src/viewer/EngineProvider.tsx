/**
 * Owns the engine for one viewer mount: the WASM scene, the scene store, the
 * render client and its canvas, and a reference to the live session. Children
 * reach the stable handle through `useEngine` and the reactive parts (scene
 * readiness, the render client's state) through `useEngineParts`.
 *
 * The session itself is built further down, by `useBridge`, because the
 * session controller calls back into the viewer's dataset and layer state.
 * The viewer reports it here through `setSession`, so the handle can read it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EngineContext, type Engine } from "../engine.ts";
import { useRenderClient } from "../hooks/useRenderClient.ts";
import { useWasmScene } from "../hooks/useWasmScene.ts";
import { SceneStore } from "../sceneStore.ts";
import type { Session } from "../session.ts";
import { EnginePartsContext } from "./engineParts.ts";

export function EngineProvider({ children }: { children: ReactNode }) {
  const scene = useWasmScene();
  const render = useRenderClient();
  const sessionRef = useRef<Session | null>(null);
  const setSession = useCallback((session: Session | null) => {
    sessionRef.current = session;
  }, []);
  // React reads the scene's view state through this store and nowhere else.
  const [store] = useState(() => new SceneStore(() => scene.wasmSceneRef.current));

  // Every part is read through a ref, so the handle is built once.
  const { wasmSceneRef } = scene;
  const { clientRef, loopRef, canvasRef } = render;
  const engine = useMemo<Engine>(() => ({
    store,
    scene: () => wasmSceneRef.current,
    session: () => sessionRef.current,
    client: () => clientRef.current,
    loop: () => loopRef.current,
    canvas: () => canvasRef.current,
  }), [store, wasmSceneRef, clientRef, loopRef, canvasRef]);

  // A snapshot creates the scene, or replaces it, without a write the store
  // would hear.
  useEffect(() => {
    store.sync();
  }, [store, scene.wasmScene]);

  const parts = useMemo(() => ({ scene, render, sessionRef, setSession }), [scene, render, setSession]);
  return (
    <EngineContext.Provider value={engine}>
      <EnginePartsContext.Provider value={parts}>{children}</EnginePartsContext.Provider>
    </EngineContext.Provider>
  );
}
