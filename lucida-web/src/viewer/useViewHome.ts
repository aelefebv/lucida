/**
 * Home: the active view's camera back to the framed fit of what it shows,
 * a volume facing the way a new one does, for when a pan or zoom went too
 * far. Each view's Home button and the key run this one action; a button
 * makes its view the active one before it acts, as every control over a
 * view does.
 */
import { useCallback, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { homeOnCanvas } from "../applyAndSend.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { useCommand } from "../ui/commands.ts";
import type { KeyCombo } from "../ui/shortcuts.ts";

export const HOME_KEYS: readonly KeyCombo[] = ["0"];

interface Deps {
  /** The scene and canvas, once both exist. */
  viewers: { scene: WasmScene; canvas: HTMLCanvasElement } | null;
  loopRef: RefObject<RenderLoop | null>;
  /** A camera moved by hand stops following another member. */
  breakFollow: () => void;
  emitPresence: () => void;
}

/** Registers Home's key, and returns the action for the buttons, or null until there is a scene. */
export function useViewHome({ viewers, loopRef, breakFollow, emitPresence }: Deps): (() => void) | null {
  const home = useCallback(() => {
    if (!viewers) return;
    breakFollow();
    homeOnCanvas(viewers.scene, viewers.canvas);
    emitPresence();
    loopRef.current?.markInput("zoom");
  }, [viewers, loopRef, breakFollow, emitPresence]);
  useCommand({
    id: "view.home",
    label: "Home: fit the active view to its data",
    group: "View",
    keys: HOME_KEYS,
    keywords: ["reset", "fit", "frame"],
    enabled: viewers !== null,
    run: home,
  });
  return viewers ? home : null;
}
