/**
 * The viewer's engine as one handle: the scene, its view-state store, the
 * session, the render client, the render loop, and the canvas they draw into.
 *
 * Built once per viewer mount (see `viewer/EngineProvider.tsx`) and handed
 * down through context, so a consumer holds one identity for the viewer's
 * life. Each part is read through a getter at call time, never captured,
 * because the scene, session, client, and loop each come and go within that
 * life (a reconnect, a 2D/3D switch).
 */
import { createContext, useContext } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { RenderLoop } from "./renderLoop.ts";
import type { SceneStore } from "./sceneStore.ts";
import type { Session } from "./session.ts";

export interface Engine {
  /** The scene's view state, for React to read. */
  readonly store: SceneStore;
  scene(): WasmScene | null;
  session(): Session | null;
  client(): RenderClient | null;
  loop(): RenderLoop | null;
  canvas(): HTMLCanvasElement | null;
}

export const EngineContext = createContext<Engine | null>(null);

/** The engine of the viewer this component is mounted in. */
export function useEngine(): Engine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("useEngine needs an EngineContext provider");
  return engine;
}
