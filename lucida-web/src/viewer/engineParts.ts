import { createContext, useContext } from "react";
import type { useRenderClient } from "../hooks/useRenderClient.ts";
import type { useWasmScene } from "../hooks/useWasmScene.ts";
import type { Session } from "../session.ts";

/** The engine's reactive parts: what a render reads, where `Engine` is what a
 *  handler reads. */
export interface EngineParts {
  scene: ReturnType<typeof useWasmScene>;
  render: ReturnType<typeof useRenderClient>;
  sessionRef: React.RefObject<Session | null>;
  /** Where the viewer reports the session `useBridge` built or tore down. */
  setSession: (session: Session | null) => void;
}

export const EnginePartsContext = createContext<EngineParts | null>(null);

/** The reactive parts of the engine this component is mounted under. */
export function useEngineParts(): EngineParts {
  const parts = useContext(EnginePartsContext);
  if (!parts) throw new Error("useEngineParts needs an EngineProvider");
  return parts;
}
